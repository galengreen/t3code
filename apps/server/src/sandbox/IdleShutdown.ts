/**
 * Lets a sandbox's server stop itself when nobody is using it. A sandbox's
 * machine ends with its server (a Docker container with its main process, a
 * Fly machine with its init), so this is how sandboxes stop billing on their
 * own, even while the host that made them is offline.
 *
 * Off unless `T3CODE_EXIT_WHEN_IDLE_MINUTES` is set, which only sandbox hosts
 * do. Idle means no thread has a run in progress and no client has made a
 * request for that long. Heartbeat probes and open subscriptions do not
 * count, so a tab left open overnight does not keep a sandbox running.
 */
import { WS_METHODS } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type { RpcServer } from "effect/unstable/rpc";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

const CHECK_INTERVAL = Duration.seconds(30);

/** When a client last asked this server for something. */
export class ClientActivity extends Context.Service<
  ClientActivity,
  {
    readonly touch: Effect.Effect<void>;
    readonly lastActiveAt: Effect.Effect<number>;
  }
>()("t3/sandbox/IdleShutdown/ClientActivity") {}

export const clientActivityLayer = Layer.effect(
  ClientActivity,
  Effect.gen(function* () {
    const lastActiveAt = yield* Ref.make(yield* Clock.currentTimeMillis);
    return ClientActivity.of({
      touch: Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Ref.set(lastActiveAt, now))),
      lastActiveAt: Ref.get(lastActiveAt),
    });
  }),
);

/** Records each client request as activity, except the connection's heartbeat. */
export function withClientActivity(
  protocol: RpcServer.Protocol["Service"],
  touch: Effect.Effect<void>,
): RpcServer.Protocol["Service"] {
  return {
    ...protocol,
    run: (write) =>
      protocol.run((clientId, message) =>
        message._tag === "Request" && message.tag !== WS_METHODS.serverProbe
          ? Effect.andThen(touch, write(clientId, message))
          : write(clientId, message),
      ),
  };
}

/** Whether a server last used at `lastActiveAt` has been idle for `idleAfter` by `now`. */
export const isIdle = (input: {
  readonly now: number;
  readonly lastActiveAt: number;
  readonly runInProgress: boolean;
  readonly idleAfter: Duration.Duration;
}) => !input.runInProgress && input.now - input.lastActiveAt >= Duration.toMillis(input.idleAfter);

/**
 * Checks for idleness every 30 seconds and calls `stop` once idle. A run in
 * progress counts as activity, so a long turn's end starts a fresh window.
 */
export const make = (options: { readonly stop: Effect.Effect<void> }) =>
  Effect.gen(function* () {
    const minutes = yield* Config.Int("T3CODE_EXIT_WHEN_IDLE_MINUTES").pipe(Config.option);
    if (Option.isNone(minutes) || minutes.value <= 0) return;
    const idleAfter = Duration.minutes(minutes.value);
    const activity = yield* ClientActivity;
    const threads = yield* ThreadManagementService.ThreadManagementService;

    const check = Effect.gen(function* () {
      const snapshot = yield* threads.getShellSnapshot({ location: "active" });
      const runInProgress = snapshot.threads.some((thread) => thread.activeRunId !== null);
      if (runInProgress) yield* activity.touch;
      const idle = isIdle({
        now: yield* Clock.currentTimeMillis,
        lastActiveAt: yield* activity.lastActiveAt,
        runInProgress,
        idleAfter,
      });
      if (!idle) return;
      yield* Effect.logInfo("Stopping: idle", { minutes: minutes.value });
      yield* options.stop;
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("Idle check failed", { cause })));

    yield* check.pipe(Effect.repeat(Schedule.spaced(CHECK_INTERVAL)), Effect.forkScoped);
  });

/** Stops the process the way a host's stop would, so shutdown runs normally. */
export const layer = Layer.effectDiscard(
  make({ stop: Effect.sync(() => process.kill(process.pid, "SIGTERM")) }),
);
