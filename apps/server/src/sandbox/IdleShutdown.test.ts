// @effect-diagnostics nodeBuiltinImport:off - Serves Fly's API on a real unix socket.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as IdleShutdown from "./IdleShutdown.ts";

/**
 * Runs the idle check against a thread list whose run state the test controls.
 * Setting `frozen` holds the next check mid-way, as a suspended machine would.
 */
const harness = (env: Record<string, string>) =>
  Effect.gen(function* () {
    const stopped = yield* Ref.make(0);
    const running = yield* Ref.make(false);
    const frozen = yield* Ref.make<Deferred.Deferred<void> | null>(null);
    const threads = Layer.succeed(ThreadManagementService.ThreadManagementService, {
      getShellSnapshot: () =>
        Ref.get(frozen).pipe(
          Effect.flatMap((latch) => (latch ? Deferred.await(latch) : Effect.void)),
          Effect.andThen(Ref.get(running)),
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
    yield* IdleShutdown.make({ sleep: Ref.update(stopped, (count) => count + 1) }).pipe(
      Effect.provide(context),
    );
    const activity = yield* IdleShutdown.ClientActivity.pipe(Effect.provide(context));
    return { stopped, running, frozen, activity };
  });

describe("IdleShutdown", () => {
  it.effect("stops once nothing has happened for the configured time", () =>
    Effect.gen(function* () {
      const { stopped } = yield* harness({ T3CODE_SLEEP_WHEN_IDLE_MINUTES: "20" });
      yield* TestClock.adjust("19 minutes");
      expect(yield* Ref.get(stopped)).toBe(0);
      yield* TestClock.adjust("2 minutes");
      expect(yield* Ref.get(stopped)).toBeGreaterThan(0);
    }).pipe(Effect.scoped),
  );

  it.effect("waits while a run is in progress, and counts from when it ends", () =>
    Effect.gen(function* () {
      const { stopped, running } = yield* harness({ T3CODE_SLEEP_WHEN_IDLE_MINUTES: "20" });
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
      const { stopped, activity } = yield* harness({ T3CODE_SLEEP_WHEN_IDLE_MINUTES: "20" });
      yield* TestClock.adjust("15 minutes");
      yield* activity.touch;
      yield* TestClock.adjust("15 minutes");
      expect(yield* Ref.get(stopped)).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("counts waking from a sleep as activity, not the sleep's worth of idleness", () =>
    Effect.gen(function* () {
      const { stopped, frozen } = yield* harness({ T3CODE_SLEEP_WHEN_IDLE_MINUTES: "20" });
      yield* TestClock.adjust("19 minutes");
      // The machine sleeps mid-check and its clock jumps when it wakes.
      const latch = yield* Deferred.make<void>();
      yield* Ref.set(frozen, latch);
      yield* TestClock.adjust("30 seconds");
      yield* TestClock.adjust("40 seconds");
      yield* Ref.set(frozen, null);
      yield* Deferred.succeed(latch, undefined);
      yield* TestClock.adjust("19 minutes");
      expect(yield* Ref.get(stopped)).toBe(0);
      yield* TestClock.adjust("2 minutes");
      expect(yield* Ref.get(stopped)).toBeGreaterThan(0);
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

describe("suspendFlyMachine", () => {
  it.live("asks Fly's API socket to suspend this machine", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fly-api-")),
      );
      const socketPath = NodePath.join(directory, "api.sock");
      const requests: string[] = [];
      const server = NodeHttp.createServer((request, response) => {
        requests.push(`${request.method} ${request.url}`);
        response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      });
      yield* Effect.acquireRelease(
        Effect.callback<void>((resume) => {
          server.listen(socketPath, () => resume(Effect.void));
        }),
        () => Effect.sync(() => server.close()),
      );
      expect(yield* IdleShutdown.suspendFlyMachine("t3-sbx-abc", "m1", socketPath)).toBe(true);
      expect(requests).toEqual(["POST /v1/apps/t3-sbx-abc/machines/m1/suspend"]);
    }).pipe(Effect.scoped),
  );
});
