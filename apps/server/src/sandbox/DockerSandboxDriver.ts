/**
 * Runs sandboxes as Docker containers on this host.
 *
 * Every sandbox container carries `t3code.sandbox.*` labels, and listing reads
 * them back with `docker inspect`, so a sandbox removed by hand simply
 * disappears. Files live on a named volume mounted at the image's home, so
 * they survive stop and start. The sandbox's T3 port is published on
 * `sandboxPublishHost` (loopback by default), and clients connect to it there
 * directly. Docker picks a new host port each time a sandbox starts, so its
 * address is not stable across stop and start.
 *
 * Environment variables are fixed when the container is created. Sensitive
 * values reach `docker run` through its own environment rather than its
 * arguments, so they never appear in the host's process list.
 */
import {
  SandboxNotFoundError,
  SandboxOperationError,
  SandboxUnavailableError,
  type SandboxId,
  type SandboxSize,
  type SandboxState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import type {
  SandboxDriver,
  SandboxMachine,
  SandboxOperation,
  SandboxVariable,
} from "./SandboxDriver.ts";

const SANDBOX_LABEL = "t3code.sandbox";
const SANDBOX_ID_LABEL = "t3code.sandbox.id";
const SANDBOX_NAME_LABEL = "t3code.sandbox.label";
const SANDBOX_PORT = "7777/tcp";

/** Docker has no dedicated CPUs, so large gets more of them instead. */
const SIZE_LIMITS: Record<SandboxSize, { readonly cpus: string; readonly memory: string }> = {
  small: { cpus: "2", memory: "2g" },
  medium: { cpus: "4", memory: "8g" },
  large: { cpus: "8", memory: "16g" },
};

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

const sandboxState = (status: string): SandboxState =>
  status === "running" || status === "restarting"
    ? "running"
    : status === "dead"
      ? "failed"
      : "stopped";

/** URL host form of an address: IPv6 literals need brackets. */
const urlHost = (address: string) => (address.includes(":") ? `[${address}]` : address);

/** A container's labels and state as a sandbox; null for unlabelled containers. */
const toMachine = (
  container: typeof DockerContainer.Type,
  publishHost: string,
): SandboxMachine | null => {
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
  };
};

/** `--env` arguments, plus the process environment that carries sensitive values. */
const environmentArgs = (environment: ReadonlyArray<SandboxVariable>) => {
  const args: string[] = [];
  const secrets: Record<string, string> = {};
  for (const variable of environment) {
    if (variable.sensitive) {
      args.push("--env", variable.name);
      secrets[variable.name] = variable.value;
    } else {
      args.push("--env", `${variable.name}=${variable.value}`);
    }
  }
  return { args, secrets };
};

export const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const runner = yield* ProcessRunner.ProcessRunner;

  const publishHost = settings.getSettings.pipe(
    Effect.map((current) => current.sandboxPublishHost),
    Effect.mapError(() => new SandboxUnavailableError({ reason: "Settings could not be read." })),
  );

  const docker = (
    args: ReadonlyArray<string>,
    operation: SandboxOperation,
    id?: SandboxId,
    env?: Record<string, string>,
  ) =>
    runner.run({ command: "docker", args, timeout: "5 minutes", env }).pipe(
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

  const inspect = (filter: string, operation: SandboxOperation, id?: SandboxId) =>
    Effect.gen(function* () {
      const ids = (yield* docker(
        ["ps", "--all", "--quiet", "--no-trunc", "--filter", `label=${filter}`],
        operation,
        id,
      ))
        .split("\n")
        .filter((line) => line.trim().length > 0);
      if (ids.length === 0) return [];
      const host = yield* publishHost;
      const containers = yield* decodeInspect(
        yield* docker(["inspect", ...ids], operation, id),
      ).pipe(Effect.mapError((cause) => new SandboxOperationError({ operation, id, cause })));
      return containers.flatMap((container) => toMachine(container, host) ?? []);
    });

  const find: SandboxDriver["find"] = (id, operation) =>
    inspect(`${SANDBOX_ID_LABEL}=${id}`, operation, id).pipe(
      Effect.flatMap(([machine]) =>
        machine ? Effect.succeed(machine) : Effect.fail(new SandboxNotFoundError({ id })),
      ),
    );

  return {
    list: inspect(`${SANDBOX_LABEL}=1`, "list"),
    find,
    create: ({ id, label, image, size, environment }) =>
      Effect.gen(function* () {
        const host = yield* publishHost;
        const env = environmentArgs(environment);
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
            `${SANDBOX_NAME_LABEL}=${label}`,
            "--hostname",
            containerName(id),
            "--cpus",
            SIZE_LIMITS[size].cpus,
            "--memory",
            SIZE_LIMITS[size].memory,
            "--volume",
            `${volumeName(id)}:/home/dev`,
            // Only on the configured address; loopback unless set otherwise.
            "--publish",
            `${urlHost(host)}::${SANDBOX_PORT}`,
            ...env.args,
            image,
          ],
          "create",
          id,
          env.secrets,
        );
      }),
    start: (id) => docker(["start", containerName(id)], "start", id).pipe(Effect.asVoid),
    stop: (id) =>
      docker(["stop", "--time", "10", containerName(id)], "stop", id).pipe(Effect.asVoid),
    remove: (id) =>
      docker(["rm", "--force", containerName(id)], "remove", id).pipe(
        Effect.andThen(docker(["volume", "rm", "--force", volumeName(id)], "remove", id)),
        Effect.asVoid,
      ),
    exec: (id, command, operation) =>
      docker(["exec", containerName(id), ...command], operation, id),
  } satisfies SandboxDriver;
});
