/**
 * Lets a sandbox's server put its machine to sleep when its agent is idle,
 * so sandboxes stop billing on their own, even while the host that made them
 * is offline. On a Fly machine it asks Fly to suspend the machine, which keeps
 * memory and wakes in about a second; elsewhere, or if Fly refuses (machines
 * over 2 GB cannot suspend), the server exits, and the machine ends with it.
 *
 * Off unless `T3CODE_SLEEP_WHEN_IDLE_MINUTES` is set, which only sandbox hosts
 * do. Idle means no thread has had a run in progress for that long: sending a
 * message starts a run, and the agent working keeps it going. Clients being
 * connected, or browsing the sandbox, do not count. Waking does, so a sandbox
 * opened from its thread gets a full window before it can sleep again.
 */
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

const CHECK_INTERVAL = Duration.seconds(30);
/**
 * Checks this far apart mean the machine was asleep in between, however
 * briefly. A resumed machine's clock catches up some seconds after it wakes,
 * so the jump can land after the first requests do, and must not read as the
 * whole sleep's worth of idleness. A stalled event loop can look the same,
 * which only delays sleep.
 */
const WAKE_GAP = Duration.seconds(45);

/**
 * Checks for idleness every 30 seconds and calls `sleep` once idle. A run in
 * progress counts as activity, so a turn's end starts a fresh window, and so
 * does waking: when `sleep` suspends the machine, it returns once resumed.
 */
export const make = (options: { readonly sleep: Effect.Effect<void> }) =>
  Effect.gen(function* () {
    const minutes = yield* Config.Int("T3CODE_SLEEP_WHEN_IDLE_MINUTES").pipe(Config.option);
    if (Option.isNone(minutes) || minutes.value <= 0) return;
    const idleAfterMs = Duration.toMillis(Duration.minutes(minutes.value));
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const started = yield* Clock.currentTimeMillis;
    const lastActiveAt = yield* Ref.make(started);
    const lastCheckedAt = yield* Ref.make(started);

    const check = Effect.gen(function* () {
      const snapshot = yield* threads.getShellSnapshot({ location: "active" });
      const runInProgress = snapshot.threads.some((thread) => thread.activeRunId !== null);
      const now = yield* Clock.currentTimeMillis;
      const woke = now - (yield* Ref.getAndSet(lastCheckedAt, now)) > Duration.toMillis(WAKE_GAP);
      if (runInProgress || woke) yield* Ref.set(lastActiveAt, now);
      if (runInProgress || now - (yield* Ref.get(lastActiveAt)) < idleAfterMs) return;
      yield* Effect.logInfo("Sleeping: idle", { minutes: minutes.value });
      yield* options.sleep;
      const resumed = yield* Clock.currentTimeMillis;
      yield* Ref.set(lastActiveAt, resumed);
      yield* Ref.set(lastCheckedAt, resumed);
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("Idle check failed", { cause })));

    yield* check.pipe(Effect.repeat(Schedule.spaced(CHECK_INTERVAL)), Effect.forkScoped);
  });

/**
 * Asks the Machines API socket every Fly machine has, which needs no token,
 * to suspend this machine. Succeeds with whether Fly accepted. The socket is
 * root's, so the sandbox image opens it to the server's user.
 */
export const suspendFlyMachine = (app: string, machine: string, socketPath = "/.fly/api") => {
  // Node's agents honour `socketPath` as a request does, though the agent
  // options type leaves it out.
  const agentOptions = { keepAlive: false, socketPath };
  return HttpClient.execute(
    HttpClientRequest.post(`http://flaps/v1/apps/${app}/machines/${machine}/suspend`),
  ).pipe(
    Effect.flatMap((response) =>
      response.status < 300
        ? Effect.succeed(true)
        : response.text.pipe(
            Effect.flatMap((body) =>
              Effect.logWarning("Fly refused to suspend this machine", {
                status: response.status,
                body,
              }),
            ),
            Effect.as(false),
          ),
    ),
    Effect.timeout("30 seconds"),
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not reach Fly's API socket", { cause: Cause.pretty(cause) }).pipe(
        Effect.as(false),
      ),
    ),
    Effect.provide(
      NodeHttpClient.layerNodeHttpNoAgent.pipe(
        Layer.provide(NodeHttpClient.layerAgentOptions(agentOptions)),
      ),
    ),
  );
};

/** Suspends a Fly machine; otherwise stops the process the way a host's stop would. */
const sleep = Effect.gen(function* () {
  const app = yield* Config.String("FLY_APP_NAME").pipe(Config.option);
  const machine = yield* Config.String("FLY_MACHINE_ID").pipe(Config.option);
  if (Option.isSome(app) && Option.isSome(machine)) {
    if (yield* suspendFlyMachine(app.value, machine.value)) return;
    yield* Effect.logWarning("Fly did not suspend this machine; exiting instead");
  }
  process.kill(process.pid, "SIGTERM");
}).pipe(Effect.catchCause((cause) => Effect.logWarning("Could not sleep", { cause })));

export const layer = Layer.effectDiscard(make({ sleep }));
