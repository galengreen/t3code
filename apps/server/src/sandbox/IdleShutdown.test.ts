import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as IdleShutdown from "./IdleShutdown.ts";

/** Runs the idle check against a thread list whose run state the test controls. */
const harness = (env: Record<string, string>) =>
  Effect.gen(function* () {
    const stopped = yield* Ref.make(0);
    const running = yield* Ref.make(false);
    const threads = Layer.succeed(ThreadManagementService.ThreadManagementService, {
      getShellSnapshot: () =>
        Ref.get(running).pipe(
          Effect.map((isRunning) => ({
            threads: [{ activeRunId: isRunning ? "run-1" : null }],
          })),
        ),
    } as unknown as ThreadManagementService.ThreadManagementService["Service"]);
    const context = yield* Layer.build(
      Layer.mergeAll(IdleShutdown.clientActivityLayer, threads).pipe(
        Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
      ),
    );
    yield* IdleShutdown.make({ stop: Ref.update(stopped, (count) => count + 1) }).pipe(
      Effect.provide(context),
    );
    const activity = yield* IdleShutdown.ClientActivity.pipe(Effect.provide(context));
    return { stopped, running, activity };
  });

describe("IdleShutdown", () => {
  it.effect("stops once nothing has happened for the configured time", () =>
    Effect.gen(function* () {
      const { stopped } = yield* harness({ T3CODE_EXIT_WHEN_IDLE_MINUTES: "20" });
      yield* TestClock.adjust("19 minutes");
      expect(yield* Ref.get(stopped)).toBe(0);
      yield* TestClock.adjust("2 minutes");
      expect(yield* Ref.get(stopped)).toBeGreaterThan(0);
    }).pipe(Effect.scoped),
  );

  it.effect("waits while a run is in progress, and counts from when it ends", () =>
    Effect.gen(function* () {
      const { stopped, running } = yield* harness({ T3CODE_EXIT_WHEN_IDLE_MINUTES: "20" });
      yield* Ref.set(running, true);
      yield* TestClock.adjust("90 minutes");
      expect(yield* Ref.get(stopped)).toBe(0);
      yield* Ref.set(running, false);
      yield* TestClock.adjust("19 minutes");
      expect(yield* Ref.get(stopped)).toBe(0);
      yield* TestClock.adjust("2 minutes");
      expect(yield* Ref.get(stopped)).toBeGreaterThan(0);
    }).pipe(Effect.scoped),
  );

  it.effect("starts the window again on each client request", () =>
    Effect.gen(function* () {
      const { stopped, activity } = yield* harness({ T3CODE_EXIT_WHEN_IDLE_MINUTES: "20" });
      yield* TestClock.adjust("15 minutes");
      yield* activity.touch;
      yield* TestClock.adjust("15 minutes");
      expect(yield* Ref.get(stopped)).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("never stops a server that was not asked to", () =>
    Effect.gen(function* () {
      const { stopped } = yield* harness({});
      yield* TestClock.adjust("1 day");
      expect(yield* Ref.get(stopped)).toBe(0);
    }).pipe(Effect.scoped),
  );
});
