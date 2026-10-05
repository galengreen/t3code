/**
 * How long cubes ran and what that cost. No backend keeps a billing history
 * the host can read back (Fly has no billing API), so the host samples: every
 * minute it lists every backend's machines and credits the time since the
 * last sample to each one running, priced at that moment.
 *
 * A cube home sleeps while no one uses the app, and its cubes keep working
 * then. So when a sample finds the host was asleep (a gap over two minutes),
 * each Fly cube's running time in the gap is read back from its machine
 * events instead: when Fly started, suspended, or stopped it. Fly keeps the
 * last 50, which covers any likely gap; a cube deleted during the gap is
 * gone, events and all, and its time is lost. Docker cubes run beside their
 * host, which does not sleep that way, so they get at most two minutes.
 *
 * Fly machines are priced by `flyPricing`, with Fly's own prices checked
 * daily; Docker cubes run on the host's own hardware and cost nothing here.
 */
import {
  CubeOperationError,
  CubeUnavailableError,
  type CubeError,
  type CubeUsage as CubeUsageReport,
  type CubeUsageInput,
  type CubeUsagePricing,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { HttpClient } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerSettings from "../serverSettings.ts";
import { CubeDrivers, type CubeMachine } from "./CubeDriver.ts";
import type { FlyMachineEvent } from "./FlyCubeDriver.ts";
import { BUILT_IN_RATES, fetchFlyRates, usdPerSecond, type FlyRates } from "./flyPricing.ts";

const SAMPLE_INTERVAL = Duration.minutes(1);
/** A longer gap means the host was asleep; see the module comment. */
const MAX_CREDIT = Duration.minutes(2);
/** Past the longest window the usage page shows. */
const RETENTION = Duration.days(100);
const RATES_MAX_AGE = Duration.hours(24);
const HOUR_MS = 3_600_000;

const isoOf = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
const hourStartOf = (millis: number) => isoOf(millis - (millis % HOUR_MS));

/** Whether a machine runs after an event; undefined for events between states. */
const runsAfter = (status: string): boolean | undefined =>
  status === "started"
    ? true
    : ["stopping", "stopped", "suspending", "suspended", "destroying", "destroyed"].includes(status)
      ? false
      : undefined;

/**
 * When a Fly machine ran between `from` and `to`, from its events. Its state
 * at `from` is what the last event before then left it in; when the events
 * do not reach back that far, the opposite of what the first one in the
 * window changes it to; and with no events at all, the state it has now.
 */
export const runningIntervals = (
  events: ReadonlyArray<FlyMachineEvent>,
  from: number,
  to: number,
  runningNow: boolean,
): ReadonlyArray<readonly [number, number]> => {
  const changes = events
    .flatMap((event) => {
      const running = runsAfter(event.status);
      return running === undefined ? [] : [{ at: event.timestamp, running }];
    })
    .toSorted((a, b) => a.at - b.at);
  const inWindow = changes.filter((change) => change.at > from && change.at < to);
  let running =
    changes.findLast((change) => change.at <= from)?.running ??
    (inWindow[0] ? !inWindow[0].running : runningNow);
  let since = from;
  const intervals: Array<readonly [number, number]> = [];
  for (const change of inWindow) {
    if (running && !change.running) intervals.push([since, change.at]);
    if (!running && change.running) since = change.at;
    running = change.running;
  }
  if (running) intervals.push([since, to]);
  return intervals;
};

/** Whole seconds of `[start, end)` in each hour it touches. */
const hourSlices = (start: number, end: number) => {
  const slices: Array<{ readonly hourStart: string; readonly seconds: number }> = [];
  for (let at = start; at < end;) {
    const next = Math.min(end, at - (at % HOUR_MS) + HOUR_MS);
    slices.push({ hourStart: hourStartOf(at), seconds: Math.round((next - at) / 1000) });
    at = next;
  }
  return slices;
};

export class CubeUsage extends Context.Service<
  CubeUsage,
  {
    /** Credits the time since the last sample to every running cube. */
    readonly sample: Effect.Effect<void, CubeError>;
    /** Recorded hours in a window, whether or not cubes are still on. */
    readonly read: (input: CubeUsageInput) => Effect.Effect<CubeUsageReport, CubeError>;
  }
>()("t3/cube/CubeUsage") {}

interface RatesState {
  readonly rates: FlyRates;
  readonly pricing: CubeUsagePricing;
  /** The token the rates were checked with, so a new one is checked at once. */
  readonly token: string | null;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* ServerSettings.ServerSettingsService;
  const drivers = yield* CubeDrivers;
  const httpClient = yield* HttpClient.HttpClient;
  const lastSample = yield* Ref.make(yield* Clock.currentTimeMillis);
  const ratesState = yield* Ref.make<RatesState>({
    rates: BUILT_IN_RATES,
    pricing: { source: "builtIn", checkedAt: null },
    token: null,
  });

  const usageError = (cause: unknown) => new CubeOperationError({ operation: "usage", cause });

  /** Adds running time to a cube's hour. */
  const record = (
    credit: {
      readonly backend: "docker" | "fly";
      readonly machine: CubeMachine;
      readonly hourStart: string;
      readonly seconds: number;
    },
    rates: FlyRates,
  ) => {
    const { backend, machine, hourStart, seconds } = credit;
    const costUsd = machine.billing === null ? 0 : usdPerSecond(machine.billing, rates) * seconds;
    return sql`
      INSERT INTO cube_usage
        (hour_start, cube_id, backend, label, running_seconds, cost_usd)
      VALUES (${hourStart}, ${machine.id}, ${backend}, ${machine.label}, ${seconds}, ${costUsd})
      ON CONFLICT (hour_start, cube_id) DO UPDATE SET
        running_seconds = running_seconds + excluded.running_seconds,
        cost_usd = cost_usd + excluded.cost_usd,
        label = excluded.label
    `;
  };

  /** Fly's prices, asked for at most daily per token; the built-in ones otherwise. */
  const currentRates = Effect.fn("CubeUsage.currentRates")(function* (token: string) {
    const now = yield* Clock.currentTimeMillis;
    const state = yield* Ref.get(ratesState);
    const checkedAt = state.pricing.checkedAt === null ? NaN : Date.parse(state.pricing.checkedAt);
    if (state.token === token && now - checkedAt < Duration.toMillis(RATES_MAX_AGE)) {
      return state.rates;
    }
    const fetched = token
      ? yield* fetchFlyRates(token).pipe(Effect.provideService(HttpClient.HttpClient, httpClient))
      : null;
    const next: RatesState = {
      rates: fetched ?? BUILT_IN_RATES,
      pricing: {
        source: fetched ? "fly" : "builtIn",
        checkedAt: token ? isoOf(now) : null,
      },
      token,
    };
    yield* Ref.set(ratesState, next);
    return next.rates;
  });

  const sample: CubeUsage["Service"]["sample"] = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const previous = yield* Ref.getAndSet(lastSample, now);
    const asleep = now - previous > Duration.toMillis(MAX_CREDIT);
    const seconds = Math.round(Math.min(now - previous, Duration.toMillis(MAX_CREDIT)) / 1000);
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(() => new CubeUnavailableError({ reason: "Settings could not be read." })),
    );
    if (!current.enableCubes || seconds <= 0) return;

    const listed = yield* Effect.forEach(
      ["docker", "fly"] as const,
      (backend) =>
        drivers[backend].list.pipe(
          Effect.orElseSucceed(() => []),
          Effect.map((machines) => machines.map((machine) => ({ backend, machine }))),
        ),
      { concurrency: "unbounded" },
    );
    const hourStart = hourStartOf(now);
    const credits = (yield* Effect.forEach(
      listed.flat(),
      ({ backend, machine }) => {
        const sinceLastSample = [{ backend, machine, hourStart, seconds }];
        const running = machine.state === "running";
        // Without its events, a cube gets what any sample gives it.
        if (backend !== "fly" || !asleep) return Effect.succeed(running ? sinceLastSample : []);
        return drivers.fly.events(machine.id).pipe(
          Effect.map((events) =>
            runningIntervals(events, previous, now, running).flatMap(([start, end]) =>
              hourSlices(start, end).map((slice) => ({ backend, machine, ...slice })),
            ),
          ),
          Effect.orElseSucceed(() => (running ? sinceLastSample : [])),
        );
      },
      { concurrency: 4 },
    )).flat();
    const rates = credits.some(({ machine }) => machine.billing !== null)
      ? yield* currentRates(current.cubeFly.apiToken)
      : BUILT_IN_RATES;

    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          for (const credit of credits) {
            yield* record(credit, rates);
          }
          yield* sql`
            DELETE FROM cube_usage
            WHERE hour_start < ${hourStartOf(now - Duration.toMillis(RETENTION))}
          `;
        }),
      )
      .pipe(Effect.mapError(usageError));
  }).pipe(Effect.withSpan("CubeUsage.sample"));

  const read: CubeUsage["Service"]["read"] = Effect.fn("CubeUsage.read")(function* (input) {
    const since = Date.parse(input.sinceTime);
    const until = Date.parse(input.untilTime);
    if (!(since < until)) {
      return yield* usageError("The usage window is not a valid time range.");
    }
    const rows = yield* sql<{
      readonly hourStart: string;
      readonly cubeId: string;
      readonly backend: "docker" | "fly";
      readonly label: string;
      readonly runningSeconds: number;
      readonly costUsd: number;
    }>`
      SELECT
        hour_start AS "hourStart",
        cube_id AS "cubeId",
        backend AS "backend",
        label AS "label",
        running_seconds AS "runningSeconds",
        cost_usd AS "costUsd"
      FROM cube_usage
      WHERE hour_start >= ${hourStartOf(since)}
        AND hour_start < ${isoOf(until)}
      ORDER BY hour_start, cube_id
    `.pipe(Effect.mapError(usageError));
    return { buckets: rows, pricing: (yield* Ref.get(ratesState)).pricing };
  });

  return CubeUsage.of({ sample, read });
});

export const layer = Layer.effect(CubeUsage, make);

/** Samples every minute; servers with cubes off only read their settings. */
export const samplerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const usage = yield* CubeUsage;
    yield* usage.sample.pipe(
      Effect.catchCause((cause) => Effect.logWarning("Could not record cube usage", { cause })),
      Effect.delay(SAMPLE_INTERVAL),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);
