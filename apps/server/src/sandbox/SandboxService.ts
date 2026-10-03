/**
 * Creates and manages sandboxes: machines that each run their own T3 server,
 * so a paired client sees a complete, isolated environment. Where the machines
 * run is the `SandboxDriver`'s concern; this service owns what is the same
 * everywhere.
 *
 * The configured image must start a T3 server on port 7777 and put `t3` on
 * PATH, which pairing uses to mint a credential inside the sandbox. It reads
 * `T3_SANDBOX_LABEL` (the environment's name) and `REPO_URL` (cloned on first
 * start).
 */
import {
  SandboxNotRunningError,
  SandboxOperationError,
  SandboxUnavailableError,
  EnvironmentId,
  type SandboxCreateInput,
  type SandboxError,
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
import { SandboxDriver, type SandboxMachine, type SandboxOperation } from "./SandboxDriver.ts";

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
  }
>()("t3/sandbox/SandboxService") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const driver = yield* SandboxDriver;
  const httpClient = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;

  /** Current settings, once sandboxes are switched on. */
  const ensureAvailable = Effect.gen(function* () {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(() => new SandboxUnavailableError({ reason: "Settings could not be read." })),
    );
    if (!current.enableSandboxes) {
      return yield* new SandboxUnavailableError({
        reason: "Sandboxes are turned off for this server.",
      });
    }
    return current;
  });

  /** A machine with the environment it serves; null while it is still booting. */
  const summarize = (machine: SandboxMachine): Effect.Effect<SandboxSummary> =>
    machine.httpBaseUrl === null
      ? Effect.succeed({ ...machine, environmentId: null })
      : httpClient.get(`${machine.httpBaseUrl}/.well-known/t3/environment`).pipe(
          Effect.flatMap((response) => response.json),
          Effect.flatMap(decodeDescriptor),
          Effect.timeout("2 seconds"),
          Effect.map(({ environmentId }) => ({ ...machine, environmentId })),
          Effect.orElseSucceed(() => ({ ...machine, environmentId: null })),
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
  const ready = (id: SandboxMachine["id"], operation: SandboxOperation) =>
    driver.find(id, operation).pipe(
      Effect.tap((machine) => waitUntilReady(machine, operation)),
      Effect.flatMap(() => driver.find(id, operation)),
      Effect.flatMap(summarize),
    );

  const list: SandboxService["Service"]["list"] = ensureAvailable.pipe(
    Effect.andThen(driver.list),
    Effect.flatMap((machines) => Effect.forEach(machines, summarize, { concurrency: "unbounded" })),
    Effect.withSpan("SandboxService.list"),
  );

  const create: SandboxService["Service"]["create"] = Effect.fn("SandboxService.create")(
    function* (input) {
      const current = yield* ensureAvailable;
      const uuid = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) => new SandboxOperationError({ operation: "create", cause })),
      );
      const id = uuid.replaceAll("-", "").slice(0, 12);
      const label = input.label ?? id;
      yield* driver.create({
        id,
        label,
        image: current.sandboxImage,
        environment: [
          { name: "T3_HOST", value: "0.0.0.0", sensitive: false },
          { name: "T3_SANDBOX_LABEL", value: label, sensitive: false },
          ...(input.repositoryUrl
            ? [{ name: "REPO_URL", value: input.repositoryUrl, sensitive: false }]
            : []),
        ],
      });
      return yield* ready(id, "create");
    },
  );

  const start: SandboxService["Service"]["start"] = Effect.fn("SandboxService.start")(function* ({
    id,
  }) {
    yield* ensureAvailable;
    yield* driver.find(id, "start");
    yield* driver.start(id);
    return yield* ready(id, "start");
  });

  const stop: SandboxService["Service"]["stop"] = Effect.fn("SandboxService.stop")(function* ({
    id,
  }) {
    yield* ensureAvailable;
    yield* driver.find(id, "stop");
    yield* driver.stop(id);
    return yield* summarize(yield* driver.find(id, "stop"));
  });

  const remove: SandboxService["Service"]["remove"] = Effect.fn("SandboxService.remove")(
    function* ({ id }) {
      yield* ensureAvailable;
      yield* driver.find(id, "remove");
      yield* driver.remove(id);
    },
  );

  const pair: SandboxService["Service"]["pair"] = Effect.fn("SandboxService.pair")(function* ({
    id,
  }) {
    yield* ensureAvailable;
    const machine = yield* driver.find(id, "pair");
    if (machine.httpBaseUrl === null) return yield* new SandboxNotRunningError({ id });
    const stdout = yield* driver.exec(
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

  return SandboxService.of({ list, create, start, stop, remove, pair });
});

export const layer = Layer.effect(SandboxService, make);
