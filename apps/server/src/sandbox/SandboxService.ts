/**
 * Creates and manages sandboxes: Docker containers that each run their own T3
 * server, so a paired client sees a complete, isolated environment.
 *
 * Docker is the record. Every sandbox container carries `t3code.sandbox.*`
 * labels, and listing reads them back with `docker inspect`, so nothing here is
 * persisted and a sandbox removed by hand simply disappears. The sandbox's T3
 * port is published on `sandboxPublishHost` (loopback by default), and
 * clients connect to it there directly.
 *
 * The configured image must start a T3 server on port 7777 and put `t3` on
 * PATH, which pairing uses to mint a credential inside the sandbox. Docker
 * picks a new host port each time a sandbox starts, so its loopback address is
 * not stable across stop and start.
 */
import {
  SandboxNotFoundError,
  SandboxNotRunningError,
  SandboxOperationError,
  SandboxUnavailableError,
  EnvironmentId,
  type SandboxCreateInput,
  type SandboxError,
  type SandboxId,
  type SandboxIdInput,
  type SandboxPairing,
  type SandboxState,
  type SandboxSummary,
} from "@t3tools/contracts";
import { waitForHttpReady } from "@t3tools/shared/httpReadiness";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";

const SANDBOX_LABEL = "t3code.sandbox";
const SANDBOX_ID_LABEL = "t3code.sandbox.id";
const SANDBOX_NAME_LABEL = "t3code.sandbox.label";
const SANDBOX_PORT = "7777/tcp";
/** First start clones the repository and boots a server, so it gets a while. */
const READY_TIMEOUT_MS = 180_000;
const PAIRING_TTL = "15m";

const containerName = (id: SandboxId) => `t3-sandbox-${id}`;
const volumeName = (id: SandboxId) => `t3-sandbox-${id}-home`;

const DockerContainer = Schema.Struct({
  Created: Schema.String,
  Config: Schema.Struct({
    Image: Schema.String,
    Labels: Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
  }),
  State: Schema.Struct({ Status: Schema.String }),
  NetworkSettings: Schema.Struct({
    Ports: Schema.NullOr(
      Schema.Record(
        Schema.String,
        Schema.NullOr(
          Schema.Array(Schema.Struct({ HostIp: Schema.String, HostPort: Schema.String })),
        ),
      ),
    ),
  }),
});
const decodeInspect = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(DockerContainer)),
);

const PairingCredential = Schema.Struct({ credential: Schema.String, expiresAt: Schema.String });
const decodePairing = Schema.decodeUnknownEffect(Schema.fromJsonString(PairingCredential));

const sandboxState = (status: string): SandboxState =>
  status === "running" || status === "restarting"
    ? "running"
    : status === "dead"
      ? "failed"
      : "stopped";

const EnvironmentDescriptor = Schema.Struct({ environmentId: EnvironmentId });
const decodeDescriptor = Schema.decodeUnknownEffect(EnvironmentDescriptor);

/** URL host form of an address: IPv6 literals need brackets. */
const urlHost = (address: string) => (address.includes(":") ? `[${address}]` : address);

/** A container's labels and state as a sandbox; null for unlabelled containers. */
const toSummary = (
  container: typeof DockerContainer.Type,
  publishHost: string,
): SandboxSummary | null => {
  const labels = container.Config.Labels ?? {};
  const id = labels[SANDBOX_ID_LABEL];
  if (labels[SANDBOX_LABEL] !== "1" || id === undefined) return null;
  const state = sandboxState(container.State.Status);
  const port = container.NetworkSettings.Ports?.[SANDBOX_PORT]?.[0]?.HostPort;
  return {
    id,
    label: labels[SANDBOX_NAME_LABEL] ?? id,
    image: container.Config.Image,
    state,
    createdAt: container.Created,
    httpBaseUrl: state === "running" && port ? `http://${urlHost(publishHost)}:${port}` : null,
    environmentId: null,
  };
};

export class SandboxService extends Context.Service<
  SandboxService,
  {
    readonly list: Effect.Effect<ReadonlyArray<SandboxSummary>, SandboxError>;
    /** Creates and starts a sandbox, returning once its T3 server answers. */
    readonly create: (input: SandboxCreateInput) => Effect.Effect<SandboxSummary, SandboxError>;
    readonly start: (input: SandboxIdInput) => Effect.Effect<SandboxSummary, SandboxError>;
    /** Stops the container; files and conversations stay on its volume. */
    readonly stop: (input: SandboxIdInput) => Effect.Effect<SandboxSummary, SandboxError>;
    /** Deletes the container and its volume, including any unshipped work. */
    readonly remove: (input: SandboxIdInput) => Effect.Effect<void, SandboxError>;
    /** Mints a one-time pairing credential inside a running sandbox. */
    readonly pair: (input: SandboxIdInput) => Effect.Effect<SandboxPairing, SandboxError>;
  }
>()("t3/sandbox/SandboxService") {}

type Operation = SandboxOperationError["operation"];

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const runner = yield* ProcessRunner.ProcessRunner;
  const httpClient = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;

  /** Image and publish address, once sandboxes are switched on. */
  const ensureAvailable = Effect.gen(function* () {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(() => new SandboxUnavailableError({ reason: "Settings could not be read." })),
    );
    if (!current.enableSandboxes) {
      return yield* new SandboxUnavailableError({
        reason: "Sandboxes are turned off for this server.",
      });
    }
    return { image: current.sandboxImage, publishHost: current.sandboxPublishHost };
  });

  /** The environment a running sandbox serves; null while it is still booting. */
  const environmentIdOf = (summary: SandboxSummary) =>
    summary.httpBaseUrl === null
      ? Effect.succeed(summary)
      : httpClient.get(`${summary.httpBaseUrl}/.well-known/t3/environment`).pipe(
          Effect.flatMap((response) => response.json),
          Effect.flatMap(decodeDescriptor),
          Effect.timeout("2 seconds"),
          Effect.map(({ environmentId }) => ({ ...summary, environmentId })),
          Effect.orElseSucceed(() => summary),
        );

  const docker = (args: ReadonlyArray<string>, operation: Operation, id?: SandboxId) =>
    runner.run({ command: "docker", args, timeout: "5 minutes" }).pipe(
      Effect.mapError((cause) =>
        cause._tag === "ProcessSpawnError"
          ? new SandboxUnavailableError({ reason: "Docker was not found on PATH." })
          : new SandboxOperationError({ operation, id, cause }),
      ),
      Effect.flatMap((result) =>
        result.code === 0
          ? Effect.succeed(result.stdout)
          : Effect.fail(new SandboxOperationError({ operation, id, cause: result.stderr })),
      ),
    );

  const inspect = (ids: ReadonlyArray<string>, operation: Operation, id?: SandboxId) =>
    ids.length === 0
      ? Effect.succeed<ReadonlyArray<SandboxSummary>>([])
      : Effect.all([docker(["inspect", ...ids], operation, id), ensureAvailable]).pipe(
          Effect.flatMap(([stdout, { publishHost }]) =>
            decodeInspect(stdout).pipe(
              Effect.mapError((cause) => new SandboxOperationError({ operation, id, cause })),
              Effect.map((containers) =>
                containers.flatMap((container) => {
                  const summary = toSummary(container, publishHost);
                  return summary ? [summary] : [];
                }),
              ),
            ),
          ),
          Effect.flatMap((summaries) =>
            Effect.forEach(summaries, environmentIdOf, { concurrency: "unbounded" }),
          ),
        );

  const containerIds = (filter: string, operation: Operation, id?: SandboxId) =>
    docker(
      ["ps", "--all", "--quiet", "--no-trunc", "--filter", `label=${filter}`],
      operation,
      id,
    ).pipe(Effect.map((stdout) => stdout.split("\n").filter((line) => line.trim().length > 0)));

  const find = Effect.fn("SandboxService.find")(function* (id: SandboxId, operation: Operation) {
    const ids = yield* containerIds(`${SANDBOX_ID_LABEL}=${id}`, operation, id);
    const [summary] = yield* inspect(ids, operation, id);
    if (!summary) return yield* new SandboxNotFoundError({ id });
    return summary;
  });

  const waitUntilReady = (summary: SandboxSummary, operation: Operation) =>
    summary.httpBaseUrl === null
      ? Effect.fail(
          new SandboxOperationError({
            operation,
            id: summary.id,
            cause: "Container is not running.",
          }),
        )
      : waitForHttpReady({
          baseUrl: summary.httpBaseUrl,
          path: "/.well-known/t3/environment",
          timeoutMs: READY_TIMEOUT_MS,
          intervalMs: 500,
          makeError: (info) =>
            new SandboxOperationError({ operation, id: summary.id, cause: info }),
        }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient), Effect.as(summary));

  const list: SandboxService["Service"]["list"] = Effect.gen(function* () {
    yield* ensureAvailable;
    return yield* inspect(yield* containerIds(`${SANDBOX_LABEL}=1`, "list"), "list");
  }).pipe(Effect.withSpan("SandboxService.list"));

  const create: SandboxService["Service"]["create"] = Effect.fn("SandboxService.create")(
    function* (input) {
      const { image, publishHost } = yield* ensureAvailable;
      const uuid = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) => new SandboxOperationError({ operation: "create", cause })),
      );
      const id = uuid.replaceAll("-", "").slice(0, 12);
      yield* docker(
        [
          "run",
          "--detach",
          "--name",
          containerName(id),
          "--label",
          `${SANDBOX_LABEL}=1`,
          "--label",
          `${SANDBOX_ID_LABEL}=${id}`,
          "--label",
          `${SANDBOX_NAME_LABEL}=${input.label ?? id}`,
          "--hostname",
          containerName(id),
          "--volume",
          `${volumeName(id)}:/home/dev`,
          // Only on the configured address; loopback unless set otherwise.
          "--publish",
          `${urlHost(publishHost)}::${SANDBOX_PORT}`,
          "--env",
          "T3_HOST=0.0.0.0",
          // The image writes this to /etc/machine-info, which the sandbox's
          // server reports as its environment label.
          "--env",
          `T3_SANDBOX_LABEL=${input.label ?? id}`,
          ...(input.repositoryUrl ? ["--env", `REPO_URL=${input.repositoryUrl}`] : []),
          image,
        ],
        "create",
        id,
      );
      yield* waitUntilReady(yield* find(id, "create"), "create");
      return yield* find(id, "create");
    },
  );

  const start: SandboxService["Service"]["start"] = Effect.fn("SandboxService.start")(function* ({
    id,
  }) {
    yield* ensureAvailable;
    yield* find(id, "start");
    yield* docker(["start", containerName(id)], "start", id);
    yield* waitUntilReady(yield* find(id, "start"), "start");
    return yield* find(id, "start");
  });

  const stop: SandboxService["Service"]["stop"] = Effect.fn("SandboxService.stop")(function* ({
    id,
  }) {
    yield* ensureAvailable;
    yield* find(id, "stop");
    yield* docker(["stop", "--time", "10", containerName(id)], "stop", id);
    return yield* find(id, "stop");
  });

  const remove: SandboxService["Service"]["remove"] = Effect.fn("SandboxService.remove")(
    function* ({ id }) {
      yield* ensureAvailable;
      yield* find(id, "remove");
      yield* docker(["rm", "--force", containerName(id)], "remove", id);
      yield* docker(["volume", "rm", "--force", volumeName(id)], "remove", id);
    },
  );

  const pair: SandboxService["Service"]["pair"] = Effect.fn("SandboxService.pair")(function* ({
    id,
  }) {
    yield* ensureAvailable;
    const summary = yield* find(id, "pair");
    if (summary.httpBaseUrl === null) return yield* new SandboxNotRunningError({ id });
    const stdout = yield* docker(
      [
        "exec",
        containerName(id),
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
      id,
    );
    const pairing = yield* decodePairing(stdout).pipe(
      Effect.mapError((cause) => new SandboxOperationError({ operation: "pair", id, cause })),
    );
    return { httpBaseUrl: summary.httpBaseUrl, ...pairing };
  });

  return SandboxService.of({ list, create, start, stop, remove, pair });
});

export const layer = Layer.effect(SandboxService, make);
