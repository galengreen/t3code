/**
 * Creates and manages sandboxes: machines that each run their own T3 server,
 * so a paired client sees a complete, isolated environment. Where the machines
 * run is a `SandboxDriver`'s concern; this service owns what is the same
 * everywhere. New sandboxes go to the `sandboxBackend` setting's driver, and
 * each existing one is managed by whichever driver knows it.
 *
 * The configured image must start a T3 server on port 7777 and put `t3` on
 * PATH, which pairing uses to mint a credential inside the sandbox. It reads
 * `T3_SANDBOX_LABEL` (the environment's name) and `REPO_URL` (cloned on first
 * start). Every sandbox also starts with the host's `sandboxEnvironment`
 * variables, such as an agent login token.
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
} from "@t3tools/contracts";
import { waitForHttpReady } from "@t3tools/shared/httpReadiness";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";

import * as ServerSettings from "../serverSettings.ts";
import { SandboxDrivers, type SandboxMachine, type SandboxOperation } from "./SandboxDriver.ts";
import { flyAccount } from "./FlySandboxDriver.ts";

/** First start clones the repository and boots a server, so it gets a while. */
const READY_TIMEOUT_MS = 180_000;
const PAIRING_TTL = "15m";

const PairingCredential = Schema.Struct({ credential: Schema.String, expiresAt: Schema.String });
const decodePairing = Schema.decodeUnknownEffect(Schema.fromJsonString(PairingCredential));

const EnvironmentDescriptor = Schema.Struct({ environmentId: EnvironmentId });
const decodeDescriptor = Schema.decodeUnknownEffect(EnvironmentDescriptor);

export class SandboxService extends Context.Service<
  SandboxService,
  {
    readonly list: Effect.Effect<ReadonlyArray<SandboxSummary>, SandboxError>;
    /** Creates and starts a sandbox, returning once its T3 server answers. */
    readonly create: (input: SandboxCreateInput) => Effect.Effect<SandboxSummary, SandboxError>;
    readonly start: (input: SandboxIdInput) => Effect.Effect<SandboxSummary, SandboxError>;
    /** Stops the sandbox; its files and conversations are kept. */
    readonly stop: (input: SandboxIdInput) => Effect.Effect<SandboxSummary, SandboxError>;
    /** Deletes the sandbox and its files, including any unshipped work. */
    readonly remove: (input: SandboxIdInput) => Effect.Effect<void, SandboxError>;
    /** Mints a one-time pairing credential inside a running sandbox. */
    readonly pair: (input: SandboxIdInput) => Effect.Effect<SandboxPairing, SandboxError>;
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

  /** A machine with the environment it serves; null while it is still booting. */
  const summarize = (
    backend: SandboxBackend,
    machine: SandboxMachine,
  ): Effect.Effect<SandboxSummary> =>
    machine.httpBaseUrl === null
      ? Effect.succeed({ ...machine, backend, environmentId: null })
      : httpClient.get(`${machine.httpBaseUrl}/.well-known/t3/environment`).pipe(
          Effect.flatMap((response) => response.json),
          Effect.flatMap(decodeDescriptor),
          Effect.timeout("5 seconds"),
          Effect.map(({ environmentId }) => ({ ...machine, backend, environmentId })),
          Effect.orElseSucceed(() => ({ ...machine, backend, environmentId: null })),
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
      machines.flat(),
      ({ backend, machine }) => summarize(backend, machine),
      { concurrency: "unbounded" },
    );
  }).pipe(Effect.withSpan("SandboxService.list"));

  const create: SandboxService["Service"]["create"] = Effect.fn("SandboxService.create")(
    function* (input) {
      const current = yield* ensureAvailable;
      const uuid = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) => new SandboxOperationError({ operation: "create", cause })),
      );
      const id = uuid.replaceAll("-", "").slice(0, 12);
      const label = input.label ?? id;
      const backend = current.sandboxBackend;
      yield* drivers[backend].create({
        id,
        label,
        image: current.sandboxImage,
        size: current.sandboxSize,
        // The image's own variables come last so the host's list cannot replace them.
        environment: [
          ...current.sandboxEnvironment,
          { name: "T3_HOST", value: "0.0.0.0", sensitive: false },
          { name: "T3_SANDBOX_LABEL", value: label, sensitive: false },
          ...(input.repositoryUrl
            ? [{ name: "REPO_URL", value: input.repositoryUrl, sensitive: false }]
            : []),
        ],
      });
      return yield* ready(backend, id, "create");
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
      const { backend } = yield* locate(id, "remove");
      yield* drivers[backend].remove(id);
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

  return SandboxService.of({ list, create, start, stop, remove, pair, flyAccount: flyAccountOf });
});

export const layer = Layer.effect(SandboxService, make);
