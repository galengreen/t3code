/**
 * Creates and manages sandboxes: machines that each run their own T3 server,
 * so a paired client sees a complete, isolated environment. Where the machines
 * run is a `SandboxDriver`'s concern; this service owns what is the same
 * everywhere. New sandboxes go to the `sandboxBackend` setting's driver, and
 * each existing one is managed by whichever driver knows it.
 *
 * The configured image (`packaging/sandbox` builds the reference one) must
 * start a T3 server on port 7777 as its `dev` user and put two commands on
 * PATH: `t3`, which pairing uses to mint a credential inside the sandbox, and
 * `t3-sandbox-clone <url>`, which clones a repository in the background and
 * adds it as a project. It reads `T3_SANDBOX_LABEL` (the environment's name)
 * and `T3_ENVIRONMENT_ID` (written as the server's environment id before its
 * first start, so the host knows it even while the sandbox sleeps). Every
 * sandbox also starts with the host's `sandboxEnvironment` variables, such as
 * an agent login token.
 *
 * With `sandboxKeepReady` on, the host keeps one spare: a sandbox booted with
 * the current settings and parked (suspended where the backend can), with no
 * repository yet. Creating claims it, wakes it, and starts its clone, which
 * takes seconds instead of a full boot. Changing the settings that shape a
 * sandbox replaces the spare, since its variables are fixed at creation.
 */
import {
  SandboxNotFoundError,
  SandboxNotRunningError,
  SandboxOperationError,
  SandboxUnavailableError,
  EnvironmentId,
  type SandboxBackend,
  type SandboxCreateInput,
  type SandboxError,
  type SandboxFlyAccount,
  type SandboxFlyAccountInput,
  type SandboxId,
  type SandboxIdInput,
  type SandboxPairing,
  type SandboxSummary,
  type ServerSettings as SandboxSettings,
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
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { SandboxDrivers, type SandboxMachine, type SandboxOperation } from "./SandboxDriver.ts";
import { flyAccount } from "./FlySandboxDriver.ts";

/** First start clones the repository and boots a server, so it gets a while. */
const READY_TIMEOUT_MS = 180_000;
const PAIRING_TTL = "15m";

const PairingCredential = Schema.Struct({ credential: Schema.String, expiresAt: Schema.String });
const decodePairing = Schema.decodeUnknownEffect(Schema.fromJsonString(PairingCredential));

const EnvironmentDescriptor = Schema.Struct({ environmentId: EnvironmentId });

/** Long enough for a client that was away for a while to still learn a sandbox went. */
const REMOVED_RETENTION = Duration.days(90);
const RemovedRecords = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ environmentId: EnvironmentId, removedAt: Schema.Number })),
);
const decodeRemovedRecords = Schema.decodeUnknownEffect(RemovedRecords);
const encodeRemovedRecords = Schema.encodeEffect(RemovedRecords);
const decodeDescriptor = Schema.decodeUnknownEffect(EnvironmentDescriptor);

/** A spare is named before anyone knows what it will be for, so every sandbox is named by id. */
const sandboxLabel = (id: SandboxId) => `Sandbox ${id.slice(0, 6)}`;

/**
 * The settings a sandbox's machine is made with. A spare made under a
 * different fingerprint would start with stale variables or the wrong image.
 */
const spareFingerprint = (current: SandboxSettings) =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify([
        current.sandboxBackend,
        current.sandboxImage,
        current.sandboxSize,
        current.sandboxSleepAfterMinutes,
        current.sandboxEnvironment,
        current.sandboxBackend === "fly"
          ? [current.sandboxFly.organization, current.sandboxFly.region]
          : current.sandboxPublishHost,
      ]),
    )
    .digest("hex")
    .slice(0, 16);

export class SandboxService extends Context.Service<
  SandboxService,
  {
    readonly list: Effect.Effect<ReadonlyArray<SandboxSummary>, SandboxError>;
    /**
     * Creates and starts a sandbox, or claims the spare, returning once its T3
     * server answers. Its repository is still cloning then; the project
     * appears when the clone finishes.
     */
    readonly create: (input: SandboxCreateInput) => Effect.Effect<SandboxSummary, SandboxError>;
    readonly start: (input: SandboxIdInput) => Effect.Effect<SandboxSummary, SandboxError>;
    /** Stops the sandbox; its files and conversations are kept. */
    readonly stop: (input: SandboxIdInput) => Effect.Effect<SandboxSummary, SandboxError>;
    /** Deletes the sandbox and its files, including any unshipped work. */
    readonly remove: (input: SandboxIdInput) => Effect.Effect<void, SandboxError>;
    /** Mints a one-time pairing credential inside a running sandbox. */
    readonly pair: (input: SandboxIdInput) => Effect.Effect<SandboxPairing, SandboxError>;
    /**
     * Deletes sandboxes that have been stopped longer than the
     * `sandboxDeleteAfterDays` setting allows, returning their ids.
     */
    readonly pruneStopped: Effect.Effect<ReadonlyArray<SandboxId>, SandboxError>;
    /**
     * Environments of sandboxes deleted in the last 90 days, so every client
     * can forget its connection to one, whoever or whatever deleted it.
     */
    readonly removedEnvironments: Effect.Effect<ReadonlyArray<EnvironmentId>, SandboxError>;
    /**
     * Leaves exactly one parked spare made with the current settings, or none
     * when `sandboxKeepReady` or sandboxes are off. Other spares are deleted.
     */
    readonly keepSpareReady: Effect.Effect<void, SandboxError>;
    /** What a Fly token (the given one, else the saved one) can reach. */
    readonly flyAccount: (
      input: SandboxFlyAccountInput,
    ) => Effect.Effect<SandboxFlyAccount, SandboxError>;
  }
>()("t3/sandbox/SandboxService") {}

const BACKENDS: ReadonlyArray<SandboxBackend> = ["docker", "fly"];

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const drivers = yield* SandboxDrivers;
  const httpClient = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const removedPath = (yield* Path.Path).join(
    (yield* ServerConfig.ServerConfig).stateDir,
    "sandbox-removed.json",
  );
  const removedLock = yield* Semaphore.make(1);
  /** Held while choosing a spare to claim or delete, so no spare is both. */
  const claimLock = yield* Semaphore.make(1);
  /** Held while making a spare, so two refills never make two. */
  const spareLock = yield* Semaphore.make(1);
  const scope = yield* Effect.scope;

  /** Deleted sandboxes' environments still within the retention window. */
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

  /** Remembers a deleted sandbox's environment; losing the note only leaves a stale connection. */
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
              Effect.logWarning("Could not record a deleted sandbox", { cause }),
            ),
          );

  const readSettings = settings.getSettings.pipe(
    Effect.mapError(() => new SandboxUnavailableError({ reason: "Settings could not be read." })),
  );

  /** Current settings, once sandboxes are switched on. */
  const ensureAvailable = Effect.gen(function* () {
    const current = yield* readSettings;
    if (!current.enableSandboxes) {
      return yield* new SandboxUnavailableError({
        reason: "Sandboxes are turned off for this server.",
      });
    }
    return current;
  });

  /** The selected backend first; another backend's failures only mean it has no such sandbox. */
  const ordered = (selected: SandboxBackend) => [
    selected,
    ...BACKENDS.filter((backend) => backend !== selected),
  ];

  /** Which backend holds a sandbox, and the sandbox as it is now. */
  const locate = Effect.fn("SandboxService.locate")(function* (
    id: SandboxId,
    operation: SandboxOperation,
  ) {
    const { sandboxBackend } = yield* ensureAvailable;
    for (const backend of ordered(sandboxBackend)) {
      const found = yield* drivers[backend].find(id, operation).pipe(
        Effect.map((machine) => ({ backend, machine })),
        Effect.catchIf(
          (error) => error._tag === "SandboxNotFoundError" || backend !== sandboxBackend,
          () => Effect.succeed(null),
        ),
      );
      if (found) return found;
    }
    return yield* new SandboxNotFoundError({ id });
  });

  /**
   * A machine as clients see it. Its address is only given once its server
   * answers, so nothing pairs with a sandbox that is still booting. Sandboxes
   * record their environment when created; older ones report it when asked.
   */
  const summarize = (
    backend: SandboxBackend,
    machine: SandboxMachine,
  ): Effect.Effect<SandboxSummary> =>
    machine.httpBaseUrl === null
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

  const waitUntilReady = (machine: SandboxMachine, operation: SandboxOperation) =>
    machine.httpBaseUrl === null
      ? Effect.fail(
          new SandboxOperationError({
            operation,
            id: machine.id,
            cause: "Sandbox is not running.",
          }),
        )
      : waitForHttpReady({
          baseUrl: machine.httpBaseUrl,
          path: "/.well-known/t3/environment",
          timeoutMs: READY_TIMEOUT_MS,
          intervalMs: 500,
          makeError: (info) =>
            new SandboxOperationError({ operation, id: machine.id, cause: info }),
        }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));

  /** Waits for a just-started sandbox's server, then reports it. */
  const ready = (backend: SandboxBackend, id: SandboxId, operation: SandboxOperation) =>
    drivers[backend].find(id, operation).pipe(
      Effect.tap((machine) => waitUntilReady(machine, operation)),
      Effect.flatMap(() => drivers[backend].find(id, operation)),
      Effect.flatMap((machine) => summarize(backend, machine)),
    );

  const list: SandboxService["Service"]["list"] = Effect.gen(function* () {
    const { sandboxBackend } = yield* ensureAvailable;
    const machines = yield* Effect.forEach(
      BACKENDS,
      (backend) =>
        drivers[backend].list.pipe(
          backend === sandboxBackend ? (listed) => listed : Effect.orElseSucceed(() => []),
          Effect.map((listed) => listed.map((machine) => ({ backend, machine }))),
        ),
      { concurrency: "unbounded" },
    );
    return yield* Effect.forEach(
      machines.flat().filter(({ machine }) => machine.spare === null),
      ({ backend, machine }) => summarize(backend, machine),
      { concurrency: "unbounded" },
    );
  }).pipe(Effect.withSpan("SandboxService.list"));

  const newIdentity = Effect.gen(function* () {
    const uuid = yield* crypto.randomUUIDv4;
    const environmentId = EnvironmentId.make(yield* crypto.randomUUIDv4);
    return { id: uuid.replaceAll("-", "").slice(0, 12), environmentId };
  }).pipe(Effect.mapError((cause) => new SandboxOperationError({ operation: "create", cause })));

  /** Makes and boots a machine under the current settings; a spare when given a fingerprint. */
  const makeMachine = Effect.fn("SandboxService.makeMachine")(function* (
    current: SandboxSettings,
    spare: string | null,
  ) {
    const { id, environmentId } = yield* newIdentity;
    const label = sandboxLabel(id);
    yield* drivers[current.sandboxBackend].create({
      id,
      environmentId,
      label,
      image: current.sandboxImage,
      size: current.sandboxSize,
      spare,
      // The image's own variables come last so the host's list cannot replace them.
      environment: [
        ...current.sandboxEnvironment,
        { name: "T3_HOST", value: "0.0.0.0", sensitive: false },
        { name: "T3_SANDBOX_LABEL", value: label, sensitive: false },
        { name: "T3_ENVIRONMENT_ID", value: environmentId, sensitive: false },
        ...(current.sandboxSleepAfterMinutes > 0
          ? [
              {
                name: "T3CODE_SLEEP_WHEN_IDLE_MINUTES",
                value: String(current.sandboxSleepAfterMinutes),
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
  const claimSpare = (current: SandboxSettings) =>
    claimLock.withPermits(1)(
      Effect.gen(function* () {
        const fingerprint = spareFingerprint(current);
        const spare = (yield* listSpares).find(
          ({ backend, machine }) =>
            backend === current.sandboxBackend &&
            machine.spare === fingerprint &&
            machine.state === "stopped",
        );
        if (!spare) return null;
        yield* drivers[spare.backend].claim(spare.machine.id);
        return spare.machine.id;
      }),
    );

  const keepSpareReady: SandboxService["Service"]["keepSpareReady"] = spareLock
    .withPermits(1)(
      Effect.gen(function* () {
        const current = yield* readSettings;
        const wanted =
          current.enableSandboxes && current.sandboxKeepReady ? spareFingerprint(current) : null;
        const kept = yield* claimLock.withPermits(1)(
          Effect.gen(function* () {
            let keep: SandboxId | null = null;
            for (const { backend, machine } of yield* listSpares) {
              if (
                keep === null &&
                wanted !== null &&
                backend === current.sandboxBackend &&
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
              yield* Effect.logInfo("Deleted an outdated spare sandbox", { id: machine.id });
            }
            return keep;
          }),
        );
        if (wanted === null || kept !== null) return;

        const backend = current.sandboxBackend;
        const id = yield* makeMachine(current, wanted);
        yield* drivers[backend].find(id, "create").pipe(
          Effect.flatMap((machine) => waitUntilReady(machine, "create")),
          Effect.andThen(drivers[backend].park(id)),
          // A spare that never got ready, or whose refill was interrupted (a CLI
          // create exits right after claiming), is no use; remove it now.
          Effect.onError(() => drivers[backend].remove(id).pipe(Effect.ignore)),
        );
        yield* Effect.logInfo("A spare sandbox is ready", { id, backend });
      }),
    )
    .pipe(Effect.withSpan("SandboxService.keepSpareReady"));

  /** Refills the spare after this request, without making the request wait for it. */
  const refillSpare = keepSpareReady.pipe(
    Effect.catchCause((cause) => Effect.logWarning("Could not make a spare sandbox", { cause })),
    Effect.forkIn(scope),
  );

  const create: SandboxService["Service"]["create"] = Effect.fn("SandboxService.create")(
    function* (input) {
      const current = yield* ensureAvailable;
      const backend = current.sandboxBackend;
      const claimed = current.sandboxKeepReady
        ? yield* claimSpare(current).pipe(
            Effect.flatMap((id) =>
              id === null
                ? Effect.succeed(null)
                : drivers[backend].start(id).pipe(
                    Effect.andThen(ready(backend, id, "create")),
                    // A spare that will not wake is no use to anyone.
                    Effect.tapError(() => drivers[backend].remove(id).pipe(Effect.ignore)),
                  ),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not use the spare sandbox; making a new one", {
                cause,
              }).pipe(Effect.as(null)),
            ),
          )
        : null;
      const sandbox =
        claimed ?? (yield* ready(backend, yield* makeMachine(current, null), "create"));
      if (input.repositoryUrl) {
        yield* drivers[backend].exec(
          sandbox.id,
          ["t3-sandbox-clone", input.repositoryUrl],
          "clone",
        );
      }
      if (current.sandboxKeepReady) yield* refillSpare;
      return sandbox;
    },
  );

  const start: SandboxService["Service"]["start"] = Effect.fn("SandboxService.start")(function* ({
    id,
  }) {
    const { backend } = yield* locate(id, "start");
    yield* drivers[backend].start(id);
    return yield* ready(backend, id, "start");
  });

  const stop: SandboxService["Service"]["stop"] = Effect.fn("SandboxService.stop")(function* ({
    id,
  }) {
    const { backend } = yield* locate(id, "stop");
    yield* drivers[backend].stop(id);
    return yield* summarize(backend, yield* drivers[backend].find(id, "stop"));
  });

  const remove: SandboxService["Service"]["remove"] = Effect.fn("SandboxService.remove")(
    function* ({ id }) {
      const { backend, machine } = yield* locate(id, "remove");
      yield* drivers[backend].remove(id);
      yield* recordRemoved(machine.environmentId);
    },
  );

  const pair: SandboxService["Service"]["pair"] = Effect.fn("SandboxService.pair")(function* ({
    id,
  }) {
    const { backend, machine } = yield* locate(id, "pair");
    if (machine.httpBaseUrl === null) return yield* new SandboxNotRunningError({ id });
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
        "t3 sandbox host",
      ],
      "pair",
    );
    const pairing = yield* decodePairing(stdout).pipe(
      Effect.mapError((cause) => new SandboxOperationError({ operation: "pair", id, cause })),
    );
    return { httpBaseUrl: machine.httpBaseUrl, ...pairing };
  });

  const flyAccountOf: SandboxService["Service"]["flyAccount"] = Effect.fn(
    "SandboxService.flyAccount",
  )(function* (input) {
    const token = input.apiToken ?? (yield* readSettings).sandboxFly.apiToken;
    if (!token) return yield* new SandboxUnavailableError({ reason: "Add a Fly API token first." });
    return yield* flyAccount(token).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
  });

  const pruneStopped: SandboxService["Service"]["pruneStopped"] = Effect.gen(function* () {
    const { sandboxDeleteAfterDays } = yield* ensureAvailable;
    if (sandboxDeleteAfterDays === 0) return [];
    const cutoff =
      (yield* Clock.currentTimeMillis) - Duration.toMillis(Duration.days(sandboxDeleteAfterDays));
    const removed: SandboxId[] = [];
    for (const backend of BACKENDS) {
      // A backend that cannot be listed (Fly without a token) has nothing to prune.
      const machines = yield* drivers[backend].list.pipe(Effect.orElseSucceed(() => []));
      for (const machine of machines) {
        if (machine.spare !== null) continue;
        const stoppedAt = machine.stoppedAt === null ? NaN : Date.parse(machine.stoppedAt);
        if (machine.state !== "stopped" || !(stoppedAt < cutoff)) continue;
        yield* drivers[backend].remove(machine.id);
        yield* recordRemoved(machine.environmentId);
        yield* Effect.logInfo("Deleted a long-stopped sandbox", {
          id: machine.id,
          label: machine.label,
          stoppedAt: machine.stoppedAt,
        });
        removed.push(machine.id);
      }
    }
    return removed;
  }).pipe(Effect.withSpan("SandboxService.pruneStopped"));

  return SandboxService.of({
    list,
    create,
    start,
    stop,
    remove,
    pair,
    pruneStopped,
    removedEnvironments: ensureAvailable.pipe(
      Effect.andThen(readRemoved),
      Effect.map((records) => records.map((record) => record.environmentId)),
    ),
    flyAccount: flyAccountOf,
    keepSpareReady,
  });
});

export const layer = Layer.effect(SandboxService, make);

/**
 * Keeps the spare in step with the settings: made on start, replaced when a
 * setting that shapes sandboxes changes, deleted when keeping one or
 * sandboxes are turned off, and checked hourly in case one was lost. Servers
 * that never had sandboxes on never look for spares.
 */
export const sparesLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sandboxes = yield* SandboxService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const wasEnabled = yield* Ref.make(false);
    const refill = Effect.gen(function* () {
      const { enableSandboxes } = yield* settings.getSettings;
      // One more pass after sandboxes are turned off deletes the spare.
      if (enableSandboxes || (yield* Ref.getAndSet(wasEnabled, enableSandboxes))) {
        yield* Ref.set(wasEnabled, enableSandboxes);
        yield* sandboxes.keepSpareReady;
      }
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Could not make a spare sandbox", { cause })),
    );
    yield* Stream.merge(
      settings.streamChanges.pipe(Stream.debounce("2 seconds")),
      Stream.tick(Duration.hours(1)),
    ).pipe(
      Stream.runForEach(() => refill),
      Effect.forkScoped,
    );
  }),
);

/**
 * Prunes long-stopped sandboxes an hour after start and hourly after that.
 * Quietly does nothing on servers with sandboxes turned off.
 */
export const pruneLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sandboxes = yield* SandboxService;
    yield* sandboxes.pruneStopped.pipe(
      Effect.catchTag("SandboxUnavailableError", () => Effect.succeed([])),
      Effect.catchCause((cause) => Effect.logWarning("Sandbox pruning failed", { cause })),
      Effect.delay(Duration.hours(1)),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);
