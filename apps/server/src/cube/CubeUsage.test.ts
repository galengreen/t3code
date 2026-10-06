import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CubeDrivers, type CubeMachine } from "./CubeDriver.ts";
import type { FlyCubeDriver, FlyMachineEvent } from "./FlyCubeDriver.ts";
import * as CubeUsage from "./CubeUsage.ts";
import { BUILT_IN_RATES, usdPerSecond } from "./flyPricing.ts";

const SMALL = { cpuKind: "shared", cpus: 2, memoryMb: 2048, region: "iad" } as const;

const machine = (id: string, overrides: Partial<CubeMachine> = {}): CubeMachine => ({
  id,
  label: `Cube ${id.slice(0, 6)}`,
  image: "cube:test",
  state: "running",
  createdAt: "2026-10-01T00:00:00Z",
  stoppedAt: null,
  environmentId: null,
  httpBaseUrl: null,
  spare: null,
  billing: null,
  ...overrides,
});

const driver = (
  machines: () => ReadonlyArray<CubeMachine>,
  events: Readonly<Record<string, ReadonlyArray<FlyMachineEvent>>> = {},
) =>
  ({
    list: Effect.sync(machines),
    events: (id: string) => Effect.succeed(events[id] ?? []),
  }) as unknown as FlyCubeDriver;

const usageLayer = (options: {
  readonly docker: () => ReadonlyArray<CubeMachine>;
  readonly fly: () => ReadonlyArray<CubeMachine>;
  readonly flyEvents?: Readonly<Record<string, ReadonlyArray<FlyMachineEvent>>>;
  /** What Fly's GraphQL API answers with; a failure when absent. */
  readonly flyPrices?: { readonly shared: number; readonly performance: number };
}) =>
  CubeUsage.layer.pipe(
    Layer.provide(
      Layer.succeed(CubeDrivers, {
        docker: driver(options.docker),
        fly: driver(options.fly, options.flyEvents),
      }),
    ),
    Layer.provide(
      ServerSettings.layerTest({
        enableCubes: true,
        cubeFly: { apiToken: "fly-token", organization: "personal", region: "iad" },
      }),
    ),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              options.flyPrices
                ? Response.json({
                    data: {
                      platform: {
                        vmSizes: [
                          {
                            name: "shared-cpu-1x",
                            cpuCores: 1,
                            priceSecond: options.flyPrices.shared,
                          },
                          {
                            name: "performance-1x",
                            cpuCores: 1,
                            priceSecond: options.flyPrices.performance,
                          },
                        ],
                      },
                    },
                  })
                : new Response(null, { status: 500 }),
            ),
          ),
        ),
      ),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );

const WINDOW = { sinceTime: "2026-10-06T00:00:00.000Z", untilTime: "2026-10-07T00:00:00.000Z" };

describe("flyPricing", () => {
  it("matches Fly's published price for a small cube", () => {
    // Fly quotes shared-cpu-2x with 2 GB at $13.39 for 30 days in Ashburn.
    expect(usdPerSecond(SMALL, BUILT_IN_RATES) * 2_592_000).toBeCloseTo(13.39, 2);
  });

  it("prices regions with a markup higher", () => {
    expect(usdPerSecond({ ...SMALL, region: "syd" }, BUILT_IN_RATES)).toBeCloseTo(
      usdPerSecond(SMALL, BUILT_IN_RATES) * 1.269230769,
      12,
    );
  });
});

describe("CubeUsage", () => {
  it.effect("credits running cubes per hour and prices only Fly ones", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-06T09:58:00Z"));
      let flyState: CubeMachine["state"] = "running";
      const layer = usageLayer({
        docker: () => [machine("dockercube01"), machine("dockercube02", { state: "stopped" })],
        fly: () => [machine("flycube00001", { state: flyState, billing: SMALL })],
      });
      const report = yield* Effect.gen(function* () {
        const usage = yield* CubeUsage.CubeUsage;
        yield* TestClock.adjust("1 minute");
        yield* usage.sample;
        yield* TestClock.adjust("1 minute");
        yield* usage.sample;
        flyState = "stopped";
        yield* TestClock.adjust("1 minute");
        yield* usage.sample;
        return yield* usage.read(WINDOW);
      }).pipe(Effect.provide(layer));

      const perSecond = usdPerSecond(SMALL, BUILT_IN_RATES);
      expect(report.pricing.source).toBe("builtIn");
      expect(report.buckets).toEqual([
        expect.objectContaining({
          hourStart: "2026-10-06T09:00:00.000Z",
          cubeId: "dockercube01",
          runningSeconds: 60,
          costUsd: 0,
        }),
        expect.objectContaining({
          hourStart: "2026-10-06T09:00:00.000Z",
          cubeId: "flycube00001",
          backend: "fly",
          runningSeconds: 60,
        }),
        expect.objectContaining({
          hourStart: "2026-10-06T10:00:00.000Z",
          cubeId: "dockercube01",
          runningSeconds: 120,
        }),
        expect.objectContaining({
          hourStart: "2026-10-06T10:00:00.000Z",
          cubeId: "flycube00001",
          runningSeconds: 60,
        }),
      ]);
      expect(report.buckets[1]!.costUsd).toBeCloseTo(perSecond * 60, 12);
    }),
  );

  it.effect("gives Docker cubes at most two minutes after the host slept", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-06T09:00:00Z"));
      const report = yield* Effect.gen(function* () {
        const usage = yield* CubeUsage.CubeUsage;
        yield* TestClock.adjust("3 hours");
        yield* usage.sample;
        return yield* usage.read(WINDOW);
      }).pipe(
        Effect.provide(usageLayer({ docker: () => [machine("dockercube01")], fly: () => [] })),
      );
      expect(report.buckets.map((bucket) => bucket.runningSeconds)).toEqual([120]);
    }),
  );

  it.effect("backfills Fly cubes' running time while the host slept from their events", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-06T09:00:00Z"));
      const at = (time: string) => Date.parse(`2026-10-06T${time}Z`);
      const report = yield* Effect.gen(function* () {
        const usage = yield* CubeUsage.CubeUsage;
        // The home sleeps for three hours, and wakes to find:
        yield* TestClock.adjust("3 hours");
        yield* usage.sample;
        return yield* usage.read(WINDOW);
      }).pipe(
        Effect.provide(
          usageLayer({
            docker: () => [],
            fly: () => [
              machine("worked000001", { billing: SMALL }),
              machine("truncated001", { state: "stopped", billing: SMALL }),
            ],
            flyEvents: {
              // Running when the home slept, idle at 10:20, woken at 11:50.
              worked000001: [
                { timestamp: at("08:30:00"), status: "started" },
                { timestamp: at("10:20:00"), status: "suspending" },
                { timestamp: at("10:20:05"), status: "suspended" },
                { timestamp: at("11:49:59"), status: "starting" },
                { timestamp: at("11:50:00"), status: "started" },
              ],
              // Events that start mid-gap: suspending means it ran until then.
              truncated001: [{ timestamp: at("09:30:00"), status: "suspending" }],
            },
          }),
        ),
      );
      const seconds = report.buckets.map(({ hourStart, cubeId, runningSeconds }) => [
        hourStart.slice(11, 13),
        cubeId,
        runningSeconds,
      ]);
      expect(seconds).toEqual([
        ["09", "truncated001", 1800],
        ["09", "worked000001", 3600],
        ["10", "worked000001", 1200],
        ["11", "worked000001", 600],
      ]);
      expect(report.buckets[1]!.costUsd).toBeCloseTo(
        usdPerSecond(SMALL, BUILT_IN_RATES) * 3600,
        12,
      );
    }),
  );

  it.effect("uses Fly's own prices when they are plausible", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-06T09:00:00Z"));
      const raised = {
        shared: BUILT_IN_RATES.sharedCpuSecond * 1.1,
        performance: BUILT_IN_RATES.performanceCpuSecond * 1.1,
      };
      const report = yield* Effect.gen(function* () {
        const usage = yield* CubeUsage.CubeUsage;
        yield* TestClock.adjust("1 minute");
        yield* usage.sample;
        return yield* usage.read(WINDOW);
      }).pipe(
        Effect.provide(
          usageLayer({
            docker: () => [],
            fly: () => [machine("flycube00001", { billing: SMALL })],
            flyPrices: raised,
          }),
        ),
      );
      expect(report.pricing).toEqual({ source: "fly", checkedAt: "2026-10-06T09:01:00.000Z" });
      expect(report.buckets[0]!.costUsd).toBeCloseTo(
        usdPerSecond(SMALL, {
          sharedCpuSecond: raised.shared,
          performanceCpuSecond: raised.performance,
        }) * 60,
        12,
      );
    }),
  );

  it.effect("keeps the built-in prices when Fly's look wrong", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-06T09:00:00Z"));
      const report = yield* Effect.gen(function* () {
        const usage = yield* CubeUsage.CubeUsage;
        yield* TestClock.adjust("1 minute");
        yield* usage.sample;
        return yield* usage.read(WINDOW);
      }).pipe(
        Effect.provide(
          usageLayer({
            docker: () => [],
            fly: () => [machine("flycube00001", { billing: SMALL })],
            // A monthly price where a per-second one belongs.
            flyPrices: { shared: 2.19, performance: 33 },
          }),
        ),
      );
      expect(report.pricing.source).toBe("builtIn");
      expect(report.buckets[0]!.costUsd).toBeCloseTo(usdPerSecond(SMALL, BUILT_IN_RATES) * 60, 12);
    }),
  );
});
