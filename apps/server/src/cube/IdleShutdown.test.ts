// @effect-diagnostics nodeBuiltinImport:off - Serves Fly's API on a real unix socket.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as CubeService from "./CubeService.ts";
import * as IdleShutdown from "./IdleShutdown.ts";

/**
 * Runs the idle check against a thread list the test controls: whether a run
 * is in progress, and when the latest run finished. Setting `frozen` holds the
 * next check mid-way, as a suspended machine would. For a cube home, the
 * clients showing the app and the cube work under way are controlled too.
 */
const harness = (env: Record<string, string>) =>
  Effect.gen(function* () {
    const slept = yield* Ref.make(0);
    const running = yield* Ref.make(false);
    const completedAt = yield* Ref.make<number | null>(null);
    const frozen = yield* Ref.make<Deferred.Deferred<void> | null>(null);
    const foregroundClients = yield* Ref.make(0);
    const cubeWork = yield* Ref.make({ busy: false, lastWorkAt: 0 });
    // The clone's process id file, kept in memory: real file reads would race
    // the test clock.
    const pidFileContent = yield* Ref.make<string | null>(null);
    const fileSystem = FileSystem.layerNoop({
      readFileString: (path) =>
        Ref.get(pidFileContent).pipe(
          Effect.flatMap((content) =>
            content === null || !path.endsWith(IdleShutdown.PREPARING_PID_FILE)
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "NotFound",
                    module: "FileSystem",
                    method: "readFileString",
                    pathOrDescriptor: path,
                  }),
                )
              : Effect.succeed(content),
          ),
        ),
    });
    const threads = Layer.succeed(ThreadManagementService.ThreadManagementService, {
      getShellSnapshot: () =>
        Ref.get(frozen).pipe(
          Effect.flatMap((latch) => (latch ? Deferred.await(latch) : Effect.void)),
          Effect.andThen(Effect.all([Ref.get(running), Ref.get(completedAt)])),
          Effect.map(([isRunning, completed]) => ({
            threads: [
              {
                activeRunId: isRunning ? "run-1" : null,
                latestRunRequestedAt: null,
                latestRunCompletedAt: completed === null ? null : DateTime.makeUnsafe(completed),
              },
            ],
          })),
        ),
    } as unknown as ThreadManagementService.ThreadManagementService["Service"]);
    const policy = Layer.succeed(BackgroundPolicy.BackgroundPolicy, {
      snapshot: Ref.get(foregroundClients).pipe(
        Effect.map((activeForegroundLeaseCount) => ({ activeForegroundLeaseCount })),
      ),
    } as unknown as BackgroundPolicy.BackgroundPolicy["Service"]);
    const cubes = Layer.succeed(CubeService.CubeService, {
      work: Ref.get(cubeWork),
    } as unknown as CubeService.CubeService["Service"]);
    const context = yield* Layer.build(
      Layer.mergeAll(
        threads,
        policy,
        cubes,
        ServerConfig.layerTest(process.cwd(), { prefix: "t3code-idle-test-" }),
      ).pipe(
        Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const idle = yield* IdleShutdown.make({
      sleep: Ref.update(slept, (count) => count + 1),
    }).pipe(Effect.provide(fileSystem), Effect.provide(context));
    return {
      slept,
      running,
      completedAt,
      frozen,
      idle,
      pidFileContent,
      foregroundClients,
      cubeWork,
    };
  });

const TWENTY = { T3CODE_SLEEP_WHEN_IDLE_MINUTES: "20" };
const HOME = { T3CODE_SLEEP_WHEN_UNUSED_MINUTES: "5" };

describe("IdleShutdown", () => {
  it.effect("sleeps once there has been no agent work for the configured time", () =>
    Effect.gen(function* () {
      const { slept } = yield* harness(TWENTY);
      yield* TestClock.adjust("19 minutes");
      expect(yield* Ref.get(slept)).toBe(0);
      yield* TestClock.adjust("2 minutes");
      expect(yield* Ref.get(slept)).toBeGreaterThan(0);
    }).pipe(Effect.scoped),
  );

  it.effect("waits while a run is in progress, and counts from when it ends", () =>
    Effect.gen(function* () {
      const { slept, running } = yield* harness(TWENTY);
      yield* Ref.set(running, true);
      yield* TestClock.adjust("90 minutes");
      expect(yield* Ref.get(slept)).toBe(0);
      yield* Ref.set(running, false);
      yield* TestClock.adjust("19 minutes");
      expect(yield* Ref.get(slept)).toBe(0);
      yield* TestClock.adjust("2 minutes");
      expect(yield* Ref.get(slept)).toBeGreaterThan(0);
    }).pipe(Effect.scoped),
  );

  it.effect("counts a turn too short for the checks to see running", () =>
    Effect.gen(function* () {
      const { slept, completedAt } = yield* harness(TWENTY);
      yield* TestClock.adjust("15 minutes");
      yield* Ref.set(completedAt, yield* Clock.currentTimeMillis);
      yield* TestClock.adjust("19 minutes");
      expect(yield* Ref.get(slept)).toBe(0);
      yield* TestClock.adjust("2 minutes");
      expect(yield* Ref.get(slept)).toBeGreaterThan(0);
    }).pipe(Effect.scoped),
  );

  it.effect("gives a wake only a short grace, not the whole window", () =>
    Effect.gen(function* () {
      const { slept, frozen } = yield* harness(TWENTY);
      yield* TestClock.adjust("30 minutes");
      const before = yield* Ref.get(slept);
      expect(before).toBeGreaterThan(0);
      // The machine sleeps mid-check and its clock jumps when it wakes.
      const latch = yield* Deferred.make<void>();
      yield* Ref.set(frozen, latch);
      yield* TestClock.adjust("30 seconds");
      yield* TestClock.adjust("3 hours");
      yield* Ref.set(frozen, null);
      yield* Deferred.succeed(latch, undefined);
      yield* TestClock.adjust("1 minute");
      expect(yield* Ref.get(slept)).toBe(before);
      yield* TestClock.adjust("2 minutes");
      expect(yield* Ref.get(slept)).toBeGreaterThan(before);
    }).pipe(Effect.scoped),
  );

  it.effect("stays awake while a repository is being cloned, and ignores a dead clone", () =>
    Effect.gen(function* () {
      const { slept, pidFileContent } = yield* harness(TWENTY);
      yield* Ref.set(pidFileContent, String(process.pid));
      yield* TestClock.adjust("90 minutes");
      expect(yield* Ref.get(slept)).toBe(0);
      // A process id that is not running: the clone ended without cleaning up.
      yield* Ref.set(pidFileContent, "2147483646");
      yield* TestClock.adjust("21 minutes");
      expect(yield* Ref.get(slept)).toBeGreaterThan(0);
    }).pipe(Effect.scoped),
  );

  it.effect("sleeps on request, but not while the agent works or a clone runs", () =>
    Effect.gen(function* () {
      const { slept, running, pidFileContent, idle } = yield* harness(TWENTY);
      yield* Ref.set(running, true);
      expect((yield* idle.sleepNow.pipe(Effect.flip)).reason).toBe("The agent is still working.");
      yield* Ref.set(running, false);
      yield* Ref.set(pidFileContent, String(process.pid));
      expect((yield* idle.sleepNow.pipe(Effect.flip)).reason).toBe(
        "The repository is still being prepared.",
      );
      yield* Ref.set(pidFileContent, null);
      yield* idle.sleepNow;
      yield* TestClock.adjust("2 seconds");
      expect(yield* Ref.get(slept)).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a home awake while a client shows the app, then sleeps once unused", () =>
    Effect.gen(function* () {
      const { slept, foregroundClients, running } = yield* harness(HOME);
      yield* Ref.set(foregroundClients, 1);
      yield* TestClock.adjust("2 hours");
      expect(yield* Ref.get(slept)).toBe(0);
      yield* Ref.set(foregroundClients, 0);
      // A home runs no agents, so a thread's run means nothing to it.
      yield* Ref.set(running, true);
      yield* TestClock.adjust("4 minutes");
      expect(yield* Ref.get(slept)).toBe(0);
      yield* TestClock.adjust("2 minutes");
      expect(yield* Ref.get(slept)).toBeGreaterThan(0);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a home awake for cube work no client waits on", () =>
    Effect.gen(function* () {
      const { slept, cubeWork, idle } = yield* harness(HOME);
      yield* Ref.set(cubeWork, { busy: true, lastWorkAt: 0 });
      yield* TestClock.adjust("1 hour");
      expect(yield* Ref.get(slept)).toBe(0);
      yield* Ref.set(cubeWork, { busy: false, lastWorkAt: yield* Clock.currentTimeMillis });
      yield* TestClock.adjust("4 minutes");
      expect(yield* Ref.get(slept)).toBe(0);
      yield* TestClock.adjust("2 minutes");
      expect(yield* Ref.get(slept)).toBeGreaterThan(0);
      // Only cubes sleep on request; asking a home means someone is using it.
      expect((yield* idle.sleepNow.pipe(Effect.flip))._tag).toBe("CubeUnavailableError");
    }).pipe(Effect.scoped),
  );

  it.effect("never sleeps a server that was not asked to", () =>
    Effect.gen(function* () {
      const { slept, idle } = yield* harness({});
      yield* TestClock.adjust("1 day");
      expect(yield* Ref.get(slept)).toBe(0);
      expect((yield* idle.sleepNow.pipe(Effect.flip))._tag).toBe("CubeUnavailableError");
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
      expect(yield* IdleShutdown.suspendFlyMachine("t3-cube-abc", "m1", socketPath)).toBe(true);
      expect(requests).toEqual(["POST /v1/apps/t3-cube-abc/machines/m1/suspend"]);
    }).pipe(Effect.scoped),
  );
});
