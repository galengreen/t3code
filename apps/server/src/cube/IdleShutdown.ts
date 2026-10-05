/**
 * Lets a cube's server put its machine to sleep when its agent is idle,
 * so cubes stop billing on their own, even while the host that made them
 * is offline. On a Fly machine it asks Fly to suspend the machine, which keeps
 * memory and wakes in about a second; elsewhere, or if Fly refuses (machines
 * over 2 GB cannot suspend), the server exits, and the machine ends with it.
 *
 * Off unless `T3CODE_SLEEP_WHEN_IDLE_MINUTES` is set, which only cube hosts
 * do. Idle means no agent work for that long: sending a message starts a run,
 * and the agent working keeps it going. A repository still being cloned keeps
 * it awake too. Clients being connected, or browsing the cube, do not
 * count. Waking (boot, resume) only earns a short grace, enough to send a
 * message, so a stray request does not keep a cube up for the full window.
 */
import { CubeUnavailableError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";

import * as ServerConfig from "../config.ts";
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
/** What waking alone earns: enough to send a message, not the full window. */
const WAKE_GRACE = Duration.minutes(2);

/**
 * `t3-cube-clone` writes its process id here while it clones, so a
 * cube does not sleep mid-clone. Relative to the T3 home.
 */
export const PREPARING_PID_FILE = "preparing.pid";

/** Puts this server's machine to sleep; see the module comment. */
export class IdleShutdown extends Context.Service<
  IdleShutdown,
  {
    /**
     * Puts the machine to sleep now, unless its agent is working or its
     * repository is still being prepared. Returns first and sleeps a moment
     * later, so the answer reaches the client that asked.
     */
    readonly sleepNow: Effect.Effect<void, CubeUnavailableError>;
  }
>()("t3/cube/IdleShutdown") {}

const toMillis = (value: DateTime.Utc | null | undefined) =>
  value === null || value === undefined ? 0 : DateTime.toEpochMillis(value);

/**
 * Checks for idleness every 30 seconds and calls `sleep` once idle: nothing
 * busy, no work for the idle window, and no wake within the grace. When
 * `sleep` suspends the machine it returns once resumed, which counts as a wake.
 */
export const make = (options: { readonly sleep: Effect.Effect<void> }) =>
  Effect.gen(function* () {
    const minutes = yield* Config.Int("T3CODE_SLEEP_WHEN_IDLE_MINUTES").pipe(Config.option);
    const enabled = Option.isSome(minutes) && minutes.value > 0;
    const idleAfterMs = Duration.toMillis(Duration.minutes(Option.getOrElse(minutes, () => 0)));
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const fileSystem = yield* FileSystem.FileSystem;
    const preparingPidPath = (yield* Path.Path).join(
      (yield* ServerConfig.ServerConfig).baseDir,
      PREPARING_PID_FILE,
    );
    const started = yield* Clock.currentTimeMillis;
    const lastWorkAt = yield* Ref.make(0);
    const lastWakeAt = yield* Ref.make(started);
    const lastCheckedAt = yield* Ref.make(started);
    const scope = yield* Effect.scope;

    /** Whether a clone is running: its process id is on file and still alive. */
    const preparing = fileSystem.readFileString(preparingPidPath).pipe(
      Effect.map((content) => {
        const pid = Number.parseInt(content.trim(), 10);
        if (!Number.isInteger(pid) || pid <= 0) return false;
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      }),
      Effect.orElseSucceed(() => false),
    );

    /**
     * What the threads say: whether a run is in progress, and the newest run
     * request or completion, which catches turns too short for the sampling.
     */
    const work = Effect.gen(function* () {
      const snapshot = yield* threads.getShellSnapshot({ location: "active" });
      return {
        running: snapshot.threads.some((thread) => thread.activeRunId !== null),
        preparing: yield* preparing,
        latestWorkAt: Math.max(
          0,
          ...snapshot.threads.flatMap((thread) => [
            toMillis(thread.latestRunRequestedAt),
            toMillis(thread.latestRunCompletedAt),
          ]),
        ),
      };
    });

    const goToSleep = (reason: string) =>
      Effect.gen(function* () {
        yield* Effect.logInfo(`Sleeping: ${reason}`);
        yield* options.sleep;
        const resumed = yield* Clock.currentTimeMillis;
        yield* Ref.set(lastWakeAt, resumed);
        yield* Ref.set(lastCheckedAt, resumed);
      });

    const check = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (now - (yield* Ref.getAndSet(lastCheckedAt, now)) > Duration.toMillis(WAKE_GAP)) {
        yield* Ref.set(lastWakeAt, now);
      }
      const current = yield* work;
      if (current.running || current.preparing) {
        yield* Ref.set(lastWorkAt, now);
        return;
      }
      const workedAt = Math.max(yield* Ref.get(lastWorkAt), current.latestWorkAt);
      yield* Ref.set(lastWorkAt, workedAt);
      if (now - workedAt < idleAfterMs) return;
      if (now - (yield* Ref.get(lastWakeAt)) < Duration.toMillis(WAKE_GRACE)) return;
      // A message may have arrived since the first look.
      const again = yield* work;
      if (again.running || again.preparing || again.latestWorkAt > workedAt) return;
      yield* goToSleep(`idle for ${minutes.pipe(Option.getOrElse(() => 0))} minutes`);
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("Idle check failed", { cause })));

    if (enabled) {
      yield* check.pipe(Effect.repeat(Schedule.spaced(CHECK_INTERVAL)), Effect.forkScoped);
    }

    const sleepNow = Effect.gen(function* () {
      if (!enabled) {
        return yield* new CubeUnavailableError({ reason: "This server does not sleep." });
      }
      const current = yield* work.pipe(
        Effect.mapError(
          () => new CubeUnavailableError({ reason: "Could not check whether it is busy." }),
        ),
      );
      if (current.running) {
        return yield* new CubeUnavailableError({ reason: "The agent is still working." });
      }
      if (current.preparing) {
        return yield* new CubeUnavailableError({
          reason: "The repository is still being prepared.",
        });
      }
      yield* goToSleep("asked to").pipe(
        Effect.delay("1 second"),
        Effect.catchCause((cause) => Effect.logWarning("Could not sleep", { cause })),
        Effect.forkIn(scope),
      );
    });

    return IdleShutdown.of({ sleepNow });
  });

/**
 * Asks the Machines API socket every Fly machine has, which needs no token,
 * to suspend this machine. Succeeds with whether Fly accepted. The socket is
 * root's, so the cube image opens it to the server's user.
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

export const layer = Layer.effect(IdleShutdown, make({ sleep }));
