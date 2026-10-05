/**
 * Creates and manages cubes: machines that each run their own T3 server,
 * so a paired client sees a complete, isolated environment. Where the machines
 * run is a `CubeDriver`'s concern; this service owns what is the same
 * everywhere. New cubes go to the `cubeBackend` setting's driver, and
 * each existing one is managed by whichever driver knows it.
 *
 * The configured image (`packaging/cube` builds the reference one) must
 * start a T3 server on port 7777 as its `dev` user and put two commands on
 * PATH: `t3`, which pairing uses to mint a credential inside the cube, and
 * `t3-cube-clone <url>`, which clones a repository in the background and
 * adds it as a project. It reads `T3_CUBE_LABEL` (the environment's name)
 * and `T3_ENVIRONMENT_ID` (written as the server's environment id before its
 * first start, so the host knows it even while the cube sleeps). Every
 * cube also starts with the host's `cubeEnvironment` variables, such as
 * an agent login token.
 *
 * With `cubeKeepReady` on, the host keeps one spare: a cube booted with
 * the current settings and parked (suspended where the backend can), with no
 * repository yet. Creating claims it, wakes it, and starts its clone, which
 * takes seconds instead of a full boot. Changing the settings that shape a
 * cube replaces the spare, since its variables are fixed at creation.
 *
 * Whichever server manages cubes can hand that job to a cube home: a small
 * Fly machine made from the same image that sleeps while no one uses it, so
 * cubes can be made and managed with every computer of the user's off.
 */
import {
  EnvironmentHttpApi,
  CubeNotFoundError,
  CubeNotRunningError,
  CubeOperationError,
  CubeUnavailableError,
  EnvironmentId,
  type CubeBackend,
  type CubeCreateInput,
  type CubeError,
  type CubeFlyAccount,
  type CubeFlyAccountInput,
  type CubeId,
  type CubeIdInput,
  type CubePairing,
  type CubeSummary,
  type ServerSettings as CubeSettings,
} from "@t3tools/contracts";
import { waitForHttpReady } from "@t3tools/shared/httpReadiness";
import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CubeDrivers, type CubeMachine, type CubeOperation } from "./CubeDriver.ts";
import { flyAccount } from "./FlyCubeDriver.ts";

/** First start clones the repository and boots a server, so it gets a while. */
const READY_TIMEOUT_MS = 180_000;
const PAIRING_TTL = "15m";

const PairingCredential = Schema.Struct({ credential: Schema.String, expiresAt: Schema.String });
const decodePairing = Schema.decodeUnknownEffect(Schema.fromJsonString(PairingCredential));

const EnvironmentDescriptor = Schema.Struct({ environmentId: EnvironmentId });

/** Long enough for a client that was away for a while to still learn a cube went. */
const REMOVED_RETENTION = Duration.days(90);
const RemovedRecords = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ environmentId: EnvironmentId, removedAt: Schema.Number })),
);
const decodeRemovedRecords = Schema.decodeUnknownEffect(RemovedRecords);
const encodeRemovedRecords = Schema.encodeEffect(RemovedRecords);
const decodeDescriptor = Schema.decodeUnknownEffect(EnvironmentDescriptor);

/**
 * How long a new spare runs after its server answers before it is parked.
 * Spares suspended seconds after boot have twice resumed into a frozen
 * machine (no logs, no HTTP, no exec); those that slept after running a while
 * never have. Letting boot settle costs a minute of a small machine.
 */
const SPARE_SETTLE = Duration.minutes(1);

/** How long the cube home stays awake once no one is using it. */
const HOME_UNUSED_MINUTES = 5;
const HOME_LABEL = "Cube home";

/** A spare is named before anyone knows what it will be for, so every cube is named by id. */
const cubeLabel = (id: CubeId) => `Cube ${id.slice(0, 6)}`;

/**
 * The settings a cube's machine is made with. A spare made under a
 * different fingerprint would start with stale variables or the wrong image.
 */
const spareFingerprint = (current: CubeSettings) =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify([
        current.cubeBackend,
        current.cubeImage,
        current.cubeSize,
        current.cubeSleepAfterMinutes,
        current.cubeEnvironment,
        current.cubeBackend === "fly"
          ? [current.cubeFly.organization, current.cubeFly.region]
          : current.cubePublishHost,
      ]),
    )
    .digest("hex")
    .slice(0, 16);

export class CubeService extends Context.Service<
  CubeService,
  {
    readonly list: Effect.Effect<ReadonlyArray<CubeSummary>, CubeError>;
    /**
     * Creates and starts a cube, or claims the spare, returning once its T3
     * server answers. Its repository is still cloning then; the project
     * appears when the clone finishes.
     */
    readonly create: (input: CubeCreateInput) => Effect.Effect<CubeSummary, CubeError>;
    readonly start: (input: CubeIdInput) => Effect.Effect<CubeSummary, CubeError>;
    /** Stops the cube; its files and conversations are kept. */
    readonly stop: (input: CubeIdInput) => Effect.Effect<CubeSummary, CubeError>;
    /** Deletes the cube and its files, including any unshipped work. */
    readonly remove: (input: CubeIdInput) => Effect.Effect<void, CubeError>;
    /** Mints a one-time pairing credential inside a running cube. */
    readonly pair: (input: CubeIdInput) => Effect.Effect<CubePairing, CubeError>;
    /**
     * Deletes cubes that have been stopped longer than the
     * `cubeDeleteAfterDays` setting allows, returning their ids.
     */
    readonly pruneStopped: Effect.Effect<ReadonlyArray<CubeId>, CubeError>;
    /**
     * Environments of cubes deleted in the last 90 days, so every client
     * can forget its connection to one, whoever or whatever deleted it.
     */
    readonly removedEnvironments: Effect.Effect<ReadonlyArray<EnvironmentId>, CubeError>;
    /**
     * Leaves exactly one parked spare made with the current settings, or none
     * when `cubeKeepReady` or cubes are off. Other spares are deleted.
     */
    readonly keepSpareReady: Effect.Effect<void, CubeError>;
    /** What a Fly token (the given one, else the saved one) can reach. */
    readonly flyAccount: (input: CubeFlyAccountInput) => Effect.Effect<CubeFlyAccount, CubeError>;
    /**
     * Hands cube management to the cube home on Fly, making one if there is
     * none, and returns a pairing for it. This server then stops managing
     * cubes and forgets its Fly token, so only the home manages them.
     */
    readonly createHome: Effect.Effect<CubePairing, CubeError>;
    /**
     * Whether cube work is under way, and when it last was, so a cube home
     * stays awake for work no client is waiting on, such as refilling the spare.
     */
    readonly work: Effect.Effect<{ readonly busy: boolean; readonly lastWorkAt: number }>;
  }
>()("t3/cube/CubeService") {}

const BACKENDS: ReadonlyArray<CubeBackend> = ["docker", "fly"];

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const drivers = yield* CubeDrivers;
  const httpClient = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const removedPath = (yield* Path.Path).join(
    (yield* ServerConfig.ServerConfig).stateDir,
    "cube-removed.json",
  );
  const removedLock = yield* Semaphore.make(1);
  /** Held while choosing a spare to claim or delete, so no spare is both. */
  const claimLock = yield* Semaphore.make(1);
  /** Held while making a spare, so two refills never make two. */
  const spareLock = yield* Semaphore.make(1);
  const scope = yield* Effect.scope;
  const inFlight = yield* Ref.make(0);
  const lastWorkAt = yield* Ref.make(0);

  /** Counts `effect` as cube work while it runs; see `work`. */
  const working = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Ref.update(inFlight, (count) => count + 1),
      () => effect,
      () =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) => Ref.set(lastWorkAt, now)),
          Effect.andThen(Ref.update(inFlight, (count) => count - 1)),
        ),
    );

  /** Deleted cubes' environments still within the retention window. */
  const readRemoved = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const records = yield* fileSystem.readFileString(removedPath).pipe(
      Effect.flatMap(decodeRemovedRecords),
      Effect.orElseSucceed(() => []),
    );
    return records.filter(
      (record) => now - record.removedAt < Duration.toMillis(REMOVED_RETENTION),
    );
  });

  /** Remembers a deleted cube's environment; losing the note only leaves a stale connection. */
  const recordRemoved = (environmentId: EnvironmentId | null) =>
    environmentId === null
      ? Effect.void
      : removedLock
          .withPermits(1)(
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              const kept = (yield* readRemoved).filter(
                (record) => record.environmentId !== environmentId,
              );
              const encoded = yield* encodeRemovedRecords([
                ...kept,
                { environmentId, removedAt: now },
              ]);
              yield* fileSystem.writeFileString(removedPath, encoded);
            }),
          )
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not record a deleted cube", { cause }),
            ),
          );

  const readSettings = settings.getSettings.pipe(
    Effect.mapError(() => new CubeUnavailableError({ reason: "Settings could not be read." })),
  );

  /** Current settings, once cubes are switched on. */
  const ensureAvailable = Effect.gen(function* () {
    const current = yield* readSettings;
    if (!current.enableCubes) {
      return yield* new CubeUnavailableError({
        reason: "Cubes are turned off for this server.",
      });
    }
    return current;
  });

  /** The selected backend first; another backend's failures only mean it has no such cube. */
  const ordered = (selected: CubeBackend) => [
    selected,
    ...BACKENDS.filter((backend) => backend !== selected),
  ];

  /** Which backend holds a cube, and the cube as it is now. */
  const locate = Effect.fn("CubeService.locate")(function* (id: CubeId, operation: CubeOperation) {
    const { cubeBackend } = yield* ensureAvailable;
    for (const backend of ordered(cubeBackend)) {
      const found = yield* drivers[backend].find(id, operation).pipe(
        Effect.map((machine) => ({ backend, machine })),
        Effect.catchIf(
          (error) => error._tag === "CubeNotFoundError" || backend !== cubeBackend,
          () => Effect.succeed(null),
        ),
      );
      if (found) return found;
    }
    return yield* new CubeNotFoundError({ id });
  });

  /**
   * A machine as clients see it. A Docker cube's address is only given once
   * its server answers, so nothing pairs with one that is still booting. A Fly
   * cube is never contacted here: a request would wake a sleeping one, and
   * its address and environment are known from Fly alone.
   */
  const summarize = (backend: CubeBackend, machine: CubeMachine): Effect.Effect<CubeSummary> =>
    machine.httpBaseUrl === null || backend === "fly"
      ? Effect.succeed({ ...machine, backend })
      : httpClient.get(`${machine.httpBaseUrl}/.well-known/t3/environment`).pipe(
          Effect.flatMap((response) => response.json),
          Effect.flatMap(decodeDescriptor),
          Effect.timeout("5 seconds"),
          Effect.map(({ environmentId }) => ({
            ...machine,
            backend,
            environmentId: machine.environmentId ?? environmentId,
          })),
          Effect.orElseSucceed(() => ({ ...machine, backend, httpBaseUrl: null })),
        );

  const waitUntilReady = (machine: CubeMachine, operation: CubeOperation) =>
    machine.httpBaseUrl === null
      ? Effect.fail(
          new CubeOperationError({
            operation,
            id: machine.id,
            cause: "Cube is not running.",
          }),
        )
      : waitForHttpReady({
          baseUrl: machine.httpBaseUrl,
          path: "/.well-known/t3/environment",
          timeoutMs: READY_TIMEOUT_MS,
          intervalMs: 500,
          makeError: (info) => new CubeOperationError({ operation, id: machine.id, cause: info }),
        }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));

  /** Waits for a just-started cube's server, then reports it. */
  const ready = (backend: CubeBackend, id: CubeId, operation: CubeOperation) =>
    drivers[backend].find(id, operation).pipe(
      Effect.tap((machine) => waitUntilReady(machine, operation)),
      Effect.flatMap(() => drivers[backend].find(id, operation)),
      Effect.flatMap((machine) => summarize(backend, machine)),
    );

  const list: CubeService["Service"]["list"] = Effect.gen(function* () {
    const { cubeBackend } = yield* ensureAvailable;
    const machines = yield* Effect.forEach(
      BACKENDS,
      (backend) =>
        drivers[backend].list.pipe(
          backend === cubeBackend ? (listed) => listed : Effect.orElseSucceed(() => []),
          Effect.map((listed) => listed.map((machine) => ({ backend, machine }))),
        ),
      { concurrency: "unbounded" },
    );
    return yield* Effect.forEach(
      machines.flat().filter(({ machine }) => machine.spare === null),
      ({ backend, machine }) => summarize(backend, machine),
      { concurrency: "unbounded" },
    );
  }).pipe(Effect.withSpan("CubeService.list"));

  const newIdentity = Effect.gen(function* () {
    const uuid = yield* crypto.randomUUIDv4;
    const environmentId = EnvironmentId.make(yield* crypto.randomUUIDv4);
    return { id: uuid.replaceAll("-", "").slice(0, 12), environmentId };
  }).pipe(Effect.mapError((cause) => new CubeOperationError({ operation: "create", cause })));

  /** Makes and boots a machine under the current settings; a spare when given a fingerprint. */
  const makeMachine = Effect.fn("CubeService.makeMachine")(function* (
    current: CubeSettings,
    spare: string | null,
  ) {
    const { id, environmentId } = yield* newIdentity;
    const label = cubeLabel(id);
    yield* drivers[current.cubeBackend].create({
      id,
      environmentId,
      label,
      image: current.cubeImage,
      size: current.cubeSize,
      spare,
      // The image's own variables come last so the host's list cannot replace them.
      environment: [
        ...current.cubeEnvironment,
        { name: "T3_HOST", value: "0.0.0.0", sensitive: false },
        { name: "T3_CUBE_LABEL", value: label, sensitive: false },
        { name: "T3_ENVIRONMENT_ID", value: environmentId, sensitive: false },
        ...(current.cubeSleepAfterMinutes > 0
          ? [
              {
                name: "T3CODE_SLEEP_WHEN_IDLE_MINUTES",
                value: String(current.cubeSleepAfterMinutes),
                sensitive: false,
              },
            ]
          : []),
      ],
    });
    return id;
  });

  /** Unclaimed spares on every backend that can be listed. */
  const listSpares = Effect.forEach(BACKENDS, (backend) =>
    drivers[backend].list.pipe(
      Effect.orElseSucceed(() => []),
      Effect.map((machines) =>
        machines
          .filter((machine) => machine.spare !== null)
          .map((machine) => ({ backend, machine })),
      ),
    ),
  ).pipe(Effect.map((spares) => spares.flat()));

  /** Claims the parked spare that matches the current settings, if there is one. */
  const claimSpare = (current: CubeSettings) =>
    claimLock.withPermits(1)(
      Effect.gen(function* () {
        const fingerprint = spareFingerprint(current);
        const spare = (yield* listSpares).find(
          ({ backend, machine }) =>
            backend === current.cubeBackend &&
            machine.spare === fingerprint &&
            machine.state === "stopped",
        );
        if (!spare) return null;
        yield* drivers[spare.backend].claim(spare.machine.id);
        return spare.machine.id;
      }),
    );

  const keepSpareReady: CubeService["Service"]["keepSpareReady"] = spareLock
    .withPermits(1)(
      Effect.gen(function* () {
        const current = yield* readSettings;
        const wanted =
          current.enableCubes && current.cubeKeepReady ? spareFingerprint(current) : null;
        const kept = yield* claimLock.withPermits(1)(
          Effect.gen(function* () {
            let keep: CubeId | null = null;
            for (const { backend, machine } of yield* listSpares) {
              if (
                keep === null &&
                wanted !== null &&
                backend === current.cubeBackend &&
                machine.spare === wanted &&
                machine.state !== "failed"
              ) {
                // Nothing is making a spare while this lock is held, so a
                // running one was left awake by an interrupted refill.
                if (machine.state === "running") yield* drivers[backend].park(machine.id);
                keep = machine.id;
                continue;
              }
              yield* drivers[backend].remove(machine.id);
              yield* Effect.logInfo("Deleted an outdated spare cube", { id: machine.id });
            }
            return keep;
          }),
        );
        if (wanted === null || kept !== null) return;

        const backend = current.cubeBackend;
        const id = yield* makeMachine(current, wanted);
        yield* drivers[backend].find(id, "create").pipe(
          Effect.flatMap((machine) => waitUntilReady(machine, "create")),
          Effect.andThen(Effect.sleep(SPARE_SETTLE)),
          Effect.andThen(drivers[backend].park(id)),
          // A spare that never got ready, or whose refill was interrupted (a CLI
          // create exits right after claiming), is no use; remove it now.
          Effect.onError(() => drivers[backend].remove(id).pipe(Effect.ignore)),
        );
        yield* Effect.logInfo("A spare cube is ready", { id, backend });
      }),
    )
    .pipe(working, Effect.withSpan("CubeService.keepSpareReady"));

  /** Refills the spare after this request, without making the request wait for it. */
  const refillSpare = keepSpareReady.pipe(
    Effect.catchCause((cause) => Effect.logWarning("Could not make a spare cube", { cause })),
    Effect.forkIn(scope),
  );

  const create: CubeService["Service"]["create"] = Effect.fn("CubeService.create")(
    function* (input) {
      const current = yield* ensureAvailable;
      const backend = current.cubeBackend;
      /** Starts the clone, which detaches inside the cube and returns at once. */
      const startClone = (cube: CubeSummary) =>
        input.repositoryUrl === undefined
          ? Effect.void
          : drivers[backend]
              .exec(cube.id, ["t3-cube-clone", input.repositoryUrl], "clone")
              .pipe(Effect.asVoid);
      const claimed = current.cubeKeepReady
        ? yield* claimSpare(current).pipe(
            Effect.flatMap((id) =>
              id === null
                ? Effect.succeed(null)
                : drivers[backend].start(id).pipe(
                    Effect.andThen(ready(backend, id, "create")),
                    Effect.tap(startClone),
                    // A spare that will not wake, or wakes and then stops
                    // answering, is no use to anyone; a fresh one is made.
                    Effect.tapError(() => drivers[backend].remove(id).pipe(Effect.ignore)),
                  ),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not use the spare cube; making a new one", {
                cause,
              }).pipe(Effect.as(null)),
            ),
          )
        : null;
      const cube =
        claimed ??
        (yield* ready(backend, yield* makeMachine(current, null), "create").pipe(
          Effect.tap(startClone),
        ));
      if (current.cubeKeepReady) yield* refillSpare;
      return cube;
    },
  );

  const start: CubeService["Service"]["start"] = Effect.fn("CubeService.start")(function* ({ id }) {
    const { backend } = yield* locate(id, "start");
    yield* drivers[backend].start(id);
    return yield* ready(backend, id, "start");
  });

  const stop: CubeService["Service"]["stop"] = Effect.fn("CubeService.stop")(function* ({ id }) {
    const { backend } = yield* locate(id, "stop");
    yield* drivers[backend].stop(id);
    return yield* summarize(backend, yield* drivers[backend].find(id, "stop"));
  });

  const remove: CubeService["Service"]["remove"] = Effect.fn("CubeService.remove")(function* ({
    id,
  }) {
    const { backend, machine } = yield* locate(id, "remove");
    yield* drivers[backend].remove(id);
    yield* recordRemoved(machine.environmentId);
  });

  const pair: CubeService["Service"]["pair"] = Effect.fn("CubeService.pair")(function* ({ id }) {
    const located = yield* locate(id, "pair");
    const { backend } = located;
    let machine = located.machine;
    if (machine.state !== "running") {
      // A Fly cube is woken to be paired (a device seeing it for the first
      // time); a stopped Docker one has to be started by the user.
      if (backend !== "fly") return yield* new CubeNotRunningError({ id });
      yield* drivers[backend].start(id);
      yield* waitUntilReady(machine, "pair");
      machine = yield* drivers[backend].find(id, "pair");
    }
    if (machine.httpBaseUrl === null) return yield* new CubeNotRunningError({ id });
    const stdout = yield* drivers[backend].exec(
      id,
      [
        "t3",
        "auth",
        "pairing",
        "create",
        "--json",
        "--ttl",
        PAIRING_TTL,
        "--label",
        "t3 cube host",
      ],
      "pair",
    );
    const pairing = yield* decodePairing(stdout).pipe(
      Effect.mapError((cause) => new CubeOperationError({ operation: "pair", id, cause })),
    );
    return { httpBaseUrl: machine.httpBaseUrl, ...pairing };
  });

  const flyAccountOf: CubeService["Service"]["flyAccount"] = Effect.fn("CubeService.flyAccount")(
    function* (input) {
      const token = input.apiToken ?? (yield* readSettings).cubeFly.apiToken;
      if (!token) return yield* new CubeUnavailableError({ reason: "Add a Fly API token first." });
      return yield* flyAccount(token).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
    },
  );

  const createHome: CubeService["Service"]["createHome"] = Effect.gen(function* () {
    const current = yield* ensureAvailable;
    const fly = current.cubeFly;
    if (current.cubeBackend !== "fly" || !fly.apiToken || !fly.organization) {
      return yield* new CubeUnavailableError({
        reason:
          "A cube home runs on Fly. Connect a Fly account and choose Fly for new cubes first.",
      });
    }
    const driver = drivers.fly;
    // One left by an earlier attempt is used rather than making another.
    const home =
      (yield* driver.findHome) ??
      (yield* Effect.gen(function* () {
        const { id, environmentId } = yield* newIdentity;
        return yield* driver.createHome({
          id,
          environmentId,
          image: current.cubeImage,
          environment: [
            { name: "T3_HOST", value: "0.0.0.0", sensitive: false },
            { name: "T3_CUBE_LABEL", value: HOME_LABEL, sensitive: false },
            { name: "T3_ENVIRONMENT_ID", value: environmentId, sensitive: false },
            {
              name: "T3CODE_SLEEP_WHEN_UNUSED_MINUTES",
              value: String(HOME_UNUSED_MINUTES),
              sensitive: false,
            },
          ],
        });
      }));
    const homeError = (cause: unknown) => new CubeOperationError({ operation: "home", cause });
    yield* waitForHttpReady({
      baseUrl: home.httpBaseUrl,
      path: "/.well-known/t3/environment",
      timeoutMs: READY_TIMEOUT_MS,
      intervalMs: 500,
      makeError: homeError,
    }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
    const token = (yield* driver.execHome(home, [
      "t3",
      "auth",
      "session",
      "issue",
      "--token-only",
      "--ttl",
      "10m",
      "--label",
      "cube home setup",
    ])).trim();
    // Minted while this server can still reach Fly; it gives up its token next.
    const pairing = yield* driver
      .execHome(home, [
        "t3",
        "auth",
        "pairing",
        "create",
        "--json",
        "--ttl",
        PAIRING_TTL,
        "--label",
        "t3 cube home",
      ])
      .pipe(Effect.flatMap((stdout) => decodePairing(stdout).pipe(Effect.mapError(homeError))));

    // Two servers managing cubes would fight over the spare, so this one
    // stops first, and forgets the token so nothing here can touch Fly again.
    yield* settings
      .updateSettings({ enableCubes: false, cubeFly: { apiToken: "" } })
      .pipe(Effect.mapError(homeError));
    const homeApi = yield* HttpApiClient.make(EnvironmentHttpApi, {
      baseUrl: home.httpBaseUrl,
    }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
    yield* homeApi.settings
      .update({
        headers: { authorization: `Bearer ${token}` },
        payload: {
          enableCubes: true,
          cubeBackend: "fly",
          cubeFly: { apiToken: fly.apiToken, organization: fly.organization, region: fly.region },
          cubeImage: current.cubeImage,
          cubeSize: current.cubeSize,
          // Read settings flag secret values as stored here, which the home
          // would take as "keep yours"; it has none, so send them plain.
          cubeEnvironment: current.cubeEnvironment.map(({ name, value, sensitive }) => ({
            name,
            value,
            sensitive,
          })),
          cubeSleepAfterMinutes: current.cubeSleepAfterMinutes,
          cubeDeleteAfterDays: current.cubeDeleteAfterDays,
          cubeKeepReady: current.cubeKeepReady,
        },
      })
      .pipe(
        Effect.mapError((error) =>
          homeError(`The cube home refused its settings (${error._tag}).`),
        ),
        // The home never took over, so this server carries on.
        Effect.onError(() =>
          settings
            .updateSettings({ enableCubes: true, cubeFly: { apiToken: fly.apiToken } })
            .pipe(Effect.ignore),
        ),
      );
    yield* Effect.logInfo("Cube management moved to the cube home", { app: home.app });
    return { httpBaseUrl: home.httpBaseUrl, ...pairing };
  }).pipe(working, Effect.withSpan("CubeService.createHome"));

  const pruneStopped: CubeService["Service"]["pruneStopped"] = Effect.gen(function* () {
    const { cubeDeleteAfterDays } = yield* ensureAvailable;
    if (cubeDeleteAfterDays === 0) return [];
    const cutoff =
      (yield* Clock.currentTimeMillis) - Duration.toMillis(Duration.days(cubeDeleteAfterDays));
    const removed: CubeId[] = [];
    for (const backend of BACKENDS) {
      // A backend that cannot be listed (Fly without a token) has nothing to prune.
      const machines = yield* drivers[backend].list.pipe(Effect.orElseSucceed(() => []));
      for (const machine of machines) {
        if (machine.spare !== null) continue;
        const stoppedAt = machine.stoppedAt === null ? NaN : Date.parse(machine.stoppedAt);
        if (machine.state !== "stopped" || !(stoppedAt < cutoff)) continue;
        // Something may wake it after this list was read; the backend refuses
        // to delete a running cube, and then it is kept.
        if (!(yield* drivers[backend].removeIfStopped(machine.id))) continue;
        yield* recordRemoved(machine.environmentId);
        yield* Effect.logInfo("Deleted a long-stopped cube", {
          id: machine.id,
          label: machine.label,
          stoppedAt: machine.stoppedAt,
        });
        removed.push(machine.id);
      }
    }
    return removed;
  }).pipe(working, Effect.withSpan("CubeService.pruneStopped"));

  return CubeService.of({
    list,
    create: (input) => working(create(input)),
    start: (input) => working(start(input)),
    stop: (input) => working(stop(input)),
    remove: (input) => working(remove(input)),
    pair: (input) => working(pair(input)),
    pruneStopped,
    createHome,
    work: Effect.all({
      busy: Ref.get(inFlight).pipe(Effect.map((count) => count > 0)),
      lastWorkAt: Ref.get(lastWorkAt),
    }),
    removedEnvironments: ensureAvailable.pipe(
      Effect.andThen(readRemoved),
      Effect.map((records) => records.map((record) => record.environmentId)),
    ),
    flyAccount: flyAccountOf,
    keepSpareReady,
  });
});

export const layer = Layer.effect(CubeService, make);

/**
 * Runs `effect` now and then hourly by the wall clock, checked each minute, so
 * a server that slept for hours (a cube home) catches up within a minute of
 * waking, where an hour-long timer would wait out the hour again.
 */
const hourly = <E, R>(effect: Effect.Effect<void, E, R>) =>
  Effect.gen(function* () {
    const lastRanAt = yield* Ref.make(Number.NEGATIVE_INFINITY);
    yield* Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (now - (yield* Ref.get(lastRanAt)) < Duration.toMillis(Duration.hours(1))) return;
      yield* Ref.set(lastRanAt, now);
      yield* effect;
    }).pipe(Effect.repeat(Schedule.spaced(Duration.minutes(1))));
  });

/**
 * Keeps the spare in step with the settings: made on start, replaced when a
 * setting that shapes cubes changes, deleted when keeping one or
 * cubes are turned off, and checked hourly in case one was lost. Servers
 * that never had cubes on never look for spares.
 */
export const sparesLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const cubes = yield* CubeService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const wasEnabled = yield* Ref.make(false);
    const refill = Effect.gen(function* () {
      const { enableCubes } = yield* settings.getSettings;
      // One more pass after cubes are turned off deletes the spare.
      if (enableCubes || (yield* Ref.getAndSet(wasEnabled, enableCubes))) {
        yield* Ref.set(wasEnabled, enableCubes);
        yield* cubes.keepSpareReady;
      }
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Could not make a spare cube", { cause })),
    );
    yield* settings.streamChanges.pipe(
      Stream.debounce("2 seconds"),
      Stream.runForEach(() => refill),
      Effect.forkScoped,
    );
    yield* hourly(refill).pipe(Effect.forkScoped);
  }),
);

/**
 * Prunes long-stopped cubes on start and hourly after that. Quietly does
 * nothing on servers with cubes turned off.
 */
export const pruneLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const cubes = yield* CubeService;
    yield* hourly(
      cubes.pruneStopped.pipe(
        Effect.catchTag("CubeUnavailableError", () => Effect.succeed([])),
        Effect.catchCause((cause) => Effect.logWarning("Cube pruning failed", { cause })),
        Effect.asVoid,
      ),
    ).pipe(Effect.forkScoped);
  }),
);
