/**
 * Runs cubes as Docker containers on this host.
 *
 * Every cube container carries `t3code.cube.*` labels, and listing reads
 * them back with `docker inspect`, so a cube removed by hand simply
 * disappears. Files live on a named volume mounted at the image's home, so
 * they survive stop and start. The cube's T3 port is published on
 * `cubePublishHost` (loopback by default), and clients connect to it there
 * directly. Docker picks a new host port each time a cube starts, so its
 * address is not stable across stop and start.
 *
 * A spare is named `t3-spare-<id>` and carries the settings fingerprint it was
 * made with; claiming renames it to `t3-cube-<id>`, since labels are fixed
 * at creation. Parking pauses it, which keeps its booted server in memory.
 *
 * Environment variables are fixed when the container is created. Sensitive
 * values reach `docker run` through its own environment rather than its
 * arguments, so they never appear in the host's process list.
 */
import {
  EnvironmentId,
  CubeNotFoundError,
  CubeOperationError,
  CubeUnavailableError,
  type CubeId,
  type CubeSize,
  type CubeState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { CubeDriver, CubeMachine, CubeOperation, CubeVariable } from "./CubeDriver.ts";

const CUBE_LABEL = "t3code.cube";
const CUBE_ID_LABEL = "t3code.cube.id";
const CUBE_NAME_LABEL = "t3code.cube.label";
const CUBE_ENVIRONMENT_LABEL = "t3code.cube.environment";
const CUBE_SPARE_LABEL = "t3code.cube.spare";
const CUBE_PORT = "7777/tcp";

/** Docker has no dedicated CPUs, so large gets more of them instead. */
const SIZE_LIMITS: Record<CubeSize, { readonly cpus: string; readonly memory: string }> = {
  small: { cpus: "2", memory: "2g" },
  medium: { cpus: "4", memory: "8g" },
  large: { cpus: "8", memory: "16g" },
};

const containerName = (id: CubeId) => `t3-cube-${id}`;
const spareName = (id: CubeId) => `t3-spare-${id}`;
const volumeName = (id: CubeId) => `t3-cube-${id}-home`;

const DockerContainer = Schema.Struct({
  Id: Schema.String,
  Name: Schema.String,
  Created: Schema.String,
  Config: Schema.Struct({
    Image: Schema.String,
    Labels: Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
  }),
  State: Schema.Struct({ Status: Schema.String, FinishedAt: Schema.optional(Schema.String) }),
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

const cubeState = (status: string): CubeState =>
  status === "running" || status === "restarting"
    ? "running"
    : status === "dead"
      ? "failed"
      : "stopped";

const recordedEnvironmentId = (value: string | undefined) =>
  value ? EnvironmentId.make(value) : null;

/** URL host form of an address: IPv6 literals need brackets. */
const urlHost = (address: string) => (address.includes(":") ? `[${address}]` : address);

/** A container's labels and state as a cube; null for unlabelled containers. */
const toMachine = (
  container: typeof DockerContainer.Type,
  publishHost: string,
): CubeMachine | null => {
  const labels = container.Config.Labels ?? {};
  const id = labels[CUBE_ID_LABEL];
  if (labels[CUBE_LABEL] !== "1" || id === undefined) return null;
  const state = cubeState(container.State.Status);
  const port = container.NetworkSettings.Ports?.[CUBE_PORT]?.[0]?.HostPort;
  return {
    id,
    label: labels[CUBE_NAME_LABEL] ?? id,
    environmentId: recordedEnvironmentId(labels[CUBE_ENVIRONMENT_LABEL]),
    image: container.Config.Image,
    state,
    createdAt: container.Created,
    // Docker reports the zero time for containers that never stopped.
    stoppedAt:
      state === "running" || !container.State.FinishedAt?.startsWith("2")
        ? null
        : container.State.FinishedAt,
    httpBaseUrl: state === "running" && port ? `http://${urlHost(publishHost)}:${port}` : null,
    spare: container.Name === `/${spareName(id)}` ? (labels[CUBE_SPARE_LABEL] ?? "") : null,
  };
};

/** `--env` arguments, plus the process environment that carries sensitive values. */
const environmentArgs = (environment: ReadonlyArray<CubeVariable>) => {
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
    Effect.map((current) => current.cubePublishHost),
    Effect.mapError(() => new CubeUnavailableError({ reason: "Settings could not be read." })),
  );

  const docker = (
    args: ReadonlyArray<string>,
    operation: CubeOperation,
    id?: CubeId,
    env?: Record<string, string>,
  ) =>
    runner.run({ command: "docker", args, timeout: "5 minutes", env }).pipe(
      Effect.mapError((cause) =>
        cause._tag === "ProcessSpawnError"
          ? new CubeUnavailableError({ reason: "Docker was not found on PATH." })
          : new CubeOperationError({ operation, id, cause }),
      ),
      Effect.flatMap((result) =>
        result.code === 0
          ? Effect.succeed(result.stdout)
          : Effect.fail(new CubeOperationError({ operation, id, cause: result.stderr })),
      ),
    );

  const inspect = (filter: string, operation: CubeOperation, id?: CubeId) =>
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
      ).pipe(Effect.mapError((cause) => new CubeOperationError({ operation, id, cause })));
      return containers.flatMap((container) => toMachine(container, host) ?? []);
    });

  const find: CubeDriver["find"] = (id, operation) =>
    inspect(`${CUBE_ID_LABEL}=${id}`, operation, id).pipe(
      Effect.flatMap(([machine]) =>
        machine ? Effect.succeed(machine) : Effect.fail(new CubeNotFoundError({ id })),
      ),
    );

  /** The cube's container and its Docker status, whichever name it has now. */
  const containerOf = (id: CubeId, operation: CubeOperation) =>
    docker(
      [
        "ps",
        "--all",
        "--no-trunc",
        "--filter",
        `label=${CUBE_ID_LABEL}=${id}`,
        "--format",
        "{{.ID}} {{.State}}",
      ],
      operation,
      id,
    ).pipe(
      Effect.flatMap((stdout) => {
        const [container, status = ""] = stdout.trim().split(/\s+/);
        return container
          ? Effect.succeed({ container, status })
          : Effect.fail(new CubeNotFoundError({ id }));
      }),
    );

  return {
    list: inspect(`${CUBE_LABEL}=1`, "list"),
    find,
    create: ({ id, environmentId, label, image, size, environment, spare }) =>
      Effect.gen(function* () {
        const host = yield* publishHost;
        const env = environmentArgs(environment);
        yield* docker(
          [
            "run",
            "--detach",
            // The server runs as the main process; an init reaps the agents' orphans.
            "--init",
            "--name",
            spare === null ? containerName(id) : spareName(id),
            ...(spare === null ? [] : ["--label", `${CUBE_SPARE_LABEL}=${spare}`]),
            "--label",
            `${CUBE_LABEL}=1`,
            "--label",
            `${CUBE_ID_LABEL}=${id}`,
            "--label",
            `${CUBE_NAME_LABEL}=${label}`,
            "--label",
            `${CUBE_ENVIRONMENT_LABEL}=${environmentId}`,
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
            `${urlHost(host)}::${CUBE_PORT}`,
            ...env.args,
            image,
          ],
          "create",
          id,
          env.secrets,
        );
      }),
    start: (id) =>
      containerOf(id, "start").pipe(
        Effect.flatMap(({ container, status }) =>
          docker([status === "paused" ? "unpause" : "start", container], "start", id),
        ),
        Effect.asVoid,
      ),
    stop: (id) =>
      containerOf(id, "stop").pipe(
        Effect.flatMap(({ container, status }) =>
          // A paused container cannot stop until it runs again.
          (status === "paused" ? docker(["unpause", container], "stop", id) : Effect.void).pipe(
            Effect.andThen(docker(["stop", "--time", "10", container], "stop", id)),
          ),
        ),
        Effect.asVoid,
      ),
    park: (id) =>
      containerOf(id, "park").pipe(
        Effect.flatMap(({ container }) => docker(["pause", container], "park", id)),
        Effect.asVoid,
      ),
    claim: (id) =>
      docker(["rename", spareName(id), containerName(id)], "claim", id).pipe(Effect.asVoid),
    remove: (id) =>
      containerOf(id, "remove").pipe(
        Effect.flatMap(({ container }) => docker(["rm", "--force", container], "remove", id)),
        Effect.catchTag("CubeNotFoundError", () => Effect.void),
        Effect.andThen(docker(["volume", "rm", "--force", volumeName(id)], "remove", id)),
        Effect.asVoid,
      ),
    removeIfStopped: (id) =>
      containerOf(id, "remove").pipe(
        Effect.flatMap(({ container }) =>
          // Without `--force`, Docker refuses to remove a running container.
          docker(["rm", container], "remove", id).pipe(
            Effect.andThen(docker(["volume", "rm", "--force", volumeName(id)], "remove", id)),
            Effect.as(true),
            Effect.catchTag("CubeOperationError", () => Effect.succeed(false)),
          ),
        ),
      ),
    exec: (id, command, operation) =>
      containerOf(id, operation).pipe(
        Effect.flatMap(({ container }) =>
          docker(["exec", "--user", "dev", container, ...command], operation, id),
        ),
      ),
  } satisfies CubeDriver;
});
