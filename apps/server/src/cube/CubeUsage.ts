/**
 * How long cubes ran and what that cost. No backend keeps a history the host
 * can read back (Fly has no billing API), so the host samples: every minute
 * it lists every backend's machines and credits the time since the last
 * sample to each one running, priced at that moment. Time while the host
 * itself is off or asleep goes unrecorded; cubes sleep on their own once
 * idle, so that is rarely much.
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
import { CubeDrivers } from "./CubeDriver.ts";
import { BUILT_IN_RATES, fetchFlyRates, usdPerSecond, type FlyRates } from "./flyPricing.ts";

const SAMPLE_INTERVAL = Duration.minutes(1);
/** A longer gap means the host was asleep, and its cubes' time is unknown. */
const MAX_CREDIT = Duration.minutes(2);
/** Past the longest window the usage page shows. */
const RETENTION = Duration.days(100);
const RATES_MAX_AGE = Duration.hours(24);
const HOUR_MS = 3_600_000;

const isoOf = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
const hourStartOf = (millis: number) => isoOf(millis - (millis % HOUR_MS));

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
    const seconds = Math.round(
      Math.min(now - (yield* Ref.getAndSet(lastSample, now)), Duration.toMillis(MAX_CREDIT)) / 1000,
    );
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
    const running = listed.flat().filter(({ machine }) => machine.state === "running");
    const rates = running.some(({ machine }) => machine.billing !== null)
      ? yield* currentRates(current.cubeFly.apiToken)
      : BUILT_IN_RATES;
    const hourStart = hourStartOf(now);

    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          for (const { backend, machine } of running) {
            const costUsd =
              machine.billing === null ? 0 : usdPerSecond(machine.billing, rates) * seconds;
            yield* sql`
              INSERT INTO cube_usage
                (hour_start, cube_id, backend, label, running_seconds, cost_usd)
              VALUES (${hourStart}, ${machine.id}, ${backend}, ${machine.label}, ${seconds}, ${costUsd})
              ON CONFLICT (hour_start, cube_id) DO UPDATE SET
                running_seconds = running_seconds + excluded.running_seconds,
                cost_usd = cost_usd + excluded.cost_usd,
                label = excluded.label
            `;
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
