/**
 * Runs cubes as Fly Machines, through the Machines API with the user's own
 * Fly token, organization, and region from settings.
 *
 * Each cube is its own Fly app, `t3-cube-<id>`, holding one machine, so it
 * gets its own `https://<app>.fly.dev` address and deleting the app removes
 * everything it owns. Fly's proxy wakes a sleeping machine when a request
 * arrives, so the address is always given and connecting is how clients wake
 * a cube; the machine decides for itself when to sleep. The machine keeps its root filesystem across stops, so
 * the image's home directory and everything written to it persist like a
 * Docker cube's volume. Sensitive variables become Fly app secrets, which
 * Fly encrypts and injects as environment variables; plain ones go into the
 * machine config. The app list is the record: apps are found by name prefix.
 *
 * Fly runs `exec` as root, so commands are run as the image's `dev` user.
 *
 * A spare carries `t3code_cube_spare` metadata, which claiming deletes; Fly
 * changes metadata without restarting the machine. Parking suspends it, which
 * keeps memory and so the booted server, and resumes in about a second. Fly
 * only suspends machines of up to 2 GB, so larger ones are stopped instead.
 */
import {
  EnvironmentId,
  type CubeError,
  CubeNotFoundError,
  CubeOperationError,
  CubeUnavailableError,
  type CubeFlyAccount,
  type CubeId,
  type CubeSize,
  type CubeState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import * as ServerSettings from "../serverSettings.ts";
import type {
  CubeBilling,
  CubeDriver,
  CubeMachine,
  CubeMachineSpec,
  CubeOperation,
} from "./CubeDriver.ts";

const API_BASE = "https://api.machines.dev";
const APP_PREFIX = "t3-cube-";
const HOME_PREFIX = "t3-home-";
const SPARE_METADATA = "t3code_cube_spare";
const CUBE_PORT = 7777;
/** The first start in a region pulls the image, which can take minutes. */
const START_TIMEOUT_SECONDS = 300;
const WAIT_SECONDS = 60;

const appName = (id: CubeId) => `${APP_PREFIX}${id}`;

const GUESTS: Record<
  CubeSize,
  { readonly cpu_kind: "shared" | "performance"; readonly cpus: number; readonly memory_mb: number }
> = {
  small: { cpu_kind: "shared", cpus: 2, memory_mb: 2048 },
  medium: { cpu_kind: "shared", cpus: 4, memory_mb: 8192 },
  large: { cpu_kind: "performance", cpus: 4, memory_mb: 8192 },
};

/**
 * `fly tokens create` prints macaroons as `FlyV1 fm2_…`, which go in the header
 * as they are; a pasted macaroon without the scheme gets it back. Anything else
 * is an older bearer token.
 */
export const flyAuthorization = (token: string) =>
  /^FlyV1\s/.test(token) ? token : /^fm\d_/.test(token) ? `FlyV1 ${token}` : `Bearer ${token}`;

/** Quotes a command for `sh -c`. */
const shellJoin = (command: ReadonlyArray<string>) =>
  command.map((part) => `'${part.replaceAll("'", `'\\''`)}'`).join(" ");

const MachineSummary = Schema.Struct({
  id: Schema.String,
  state: Schema.String,
  created_at: Schema.optional(Schema.String),
  updated_at: Schema.optional(Schema.String),
  app_name: Schema.optional(Schema.String),
  region: Schema.optional(Schema.String),
  config: Schema.optional(
    Schema.Struct({
      image: Schema.optional(Schema.String),
      guest: Schema.optional(
        Schema.Struct({
          cpu_kind: Schema.optional(Schema.String),
          cpus: Schema.optional(Schema.Number),
          memory_mb: Schema.optional(Schema.Number),
        }),
      ),
      metadata: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
    }),
  ),
});
type MachineSummary = typeof MachineSummary.Type;
const decodeOrgMachines = Schema.decodeUnknownEffect(
  Schema.Struct({
    machines: Schema.NullOr(Schema.Array(MachineSummary)),
    next_cursor: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);
const decodeAppMachines = Schema.decodeUnknownEffect(Schema.Array(MachineSummary));
const MachineEvent = Schema.Struct({ timestamp: Schema.Number, status: Schema.String });
const decodeMachineEvents = Schema.decodeUnknownEffect(Schema.Array(MachineEvent));
const decodeMachine = Schema.decodeUnknownEffect(MachineSummary);
const decodeSecretsVersion = Schema.decodeUnknownEffect(
  Schema.Struct({ version: Schema.optional(Schema.Number) }),
);
const decodeExec = Schema.decodeUnknownEffect(
  Schema.Struct({
    exit_code: Schema.optional(Schema.Number),
    stdout: Schema.optional(Schema.String),
    stderr: Schema.optional(Schema.String),
  }),
);
const decodeTokenInfo = Schema.decodeUnknownEffect(
  Schema.Struct({
    tokens: Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          org_slug: Schema.optional(Schema.String),
          organization: Schema.optional(Schema.String),
        }),
      ),
    ),
  }),
);
const Region = Schema.Struct({
  code: Schema.String,
  name: Schema.String,
  deprecated: Schema.optional(Schema.Boolean),
});
// The API sends `Regions`, though its OpenAPI document says `regions`.
const decodeRegions = Schema.decodeUnknownEffect(
  Schema.Struct({
    nearest: Schema.optional(Schema.String),
    Regions: Schema.optional(Schema.Array(Region)),
    regions: Schema.optional(Schema.Array(Region)),
  }),
);

const cubeState = (state: string): CubeState =>
  state === "started" ? "running" : state === "failed" ? "failed" : "stopped";

const toMachine = (app: string, machine: MachineSummary): CubeMachine | null => {
  if (!app.startsWith(APP_PREFIX)) return null;
  const id = app.slice(APP_PREFIX.length);
  const state = cubeState(machine.state);
  return {
    id,
    label: machine.config?.metadata?.t3code_cube_label ?? id,
    environmentId: machine.config?.metadata?.t3code_cube_environment
      ? EnvironmentId.make(machine.config.metadata.t3code_cube_environment)
      : null,
    image: machine.config?.image ?? "",
    state,
    createdAt: machine.created_at ?? "",
    stoppedAt: state === "stopped" ? (machine.updated_at ?? null) : null,
    httpBaseUrl: `https://${app}.fly.dev`,
    spare: machine.config?.metadata?.[SPARE_METADATA] ?? null,
    billing: billingOf(machine),
  };
};

/** Fly bills by the machine's guest; one made without a full guest is priced as small. */
const billingOf = (machine: MachineSummary): CubeBilling => {
  const guest = machine.config?.guest;
  return {
    cpuKind: guest?.cpu_kind === "performance" ? "performance" : "shared",
    cpus: guest?.cpus ?? GUESTS.small.cpus,
    memoryMb: guest?.memory_mb ?? GUESTS.small.memory_mb,
    region: machine.region ?? null,
  };
};

interface FlyResponse {
  readonly status: number;
  /** Parsed JSON, or null when the body is empty or not JSON. */
  readonly body: unknown;
  readonly text: string;
}

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** One Machines API call; transport failures become `CubeOperationError`. */
const makeCall =
  (client: HttpClient.HttpClient) =>
  (
    token: string,
    method: "GET" | "POST" | "DELETE",
    path: string,
    operation: CubeOperation,
    id?: CubeId,
    body?: unknown,
  ): Effect.Effect<FlyResponse, CubeOperationError | CubeUnavailableError> => {
    const base =
      method === "GET"
        ? HttpClientRequest.get(`${API_BASE}${path}`)
        : method === "POST"
          ? HttpClientRequest.post(`${API_BASE}${path}`)
          : HttpClientRequest.delete(`${API_BASE}${path}`);
    const request = base.pipe(
      HttpClientRequest.setHeader("Authorization", flyAuthorization(token)),
      HttpClientRequest.setHeader("Accept", "application/json"),
    );
    return client
      .execute(body === undefined ? request : request.pipe(HttpClientRequest.bodyJsonUnsafe(body)))
      .pipe(
        Effect.flatMap((response) =>
          response.text.pipe(
            Effect.map((text): FlyResponse => ({
              status: response.status,
              body: Option.getOrNull(parseJson(text)),
              text,
            })),
          ),
        ),
        // Waits for state are held server-side for up to a minute.
        Effect.timeout(`${WAIT_SECONDS + 30} seconds`),
        Effect.mapError((cause) => new CubeOperationError({ operation, id, cause })),
        Effect.flatMap((response) =>
          response.status === 401
            ? Effect.fail(
                new CubeUnavailableError({
                  reason: "Fly rejected the API token. Check it in Settings.",
                }),
              )
            : Effect.succeed(response),
        ),
      );
  };

const expectOk = (
  response: FlyResponse,
  operation: CubeOperation,
  id?: CubeId,
): Effect.Effect<unknown, CubeOperationError> =>
  response.status >= 200 && response.status < 300
    ? Effect.succeed(response.body)
    : Effect.fail(
        new CubeOperationError({
          operation,
          id,
          cause: `Fly answered ${response.status}: ${
            typeof response.body === "object" && response.body !== null && "error" in response.body
              ? String(response.body.error)
              : response.text
          }`,
        }),
      );

/** What a token can reach: its organizations and Fly's regions. */
export const flyAccount = Effect.fn("FlyCubeDriver.account")(function* (token: string) {
  const call = makeCall(yield* HttpClient.HttpClient);
  const [tokenResponse, regionsResponse] = yield* Effect.all(
    [
      call(token, "GET", "/v1/tokens/current", "account"),
      call(token, "GET", "/v1/platform/regions", "account"),
    ],
    { concurrency: 2 },
  );
  const toError = (cause: unknown) => new CubeOperationError({ operation: "account", cause });
  const info = yield* expectOk(tokenResponse, "account").pipe(
    Effect.flatMap((body) => decodeTokenInfo(body).pipe(Effect.mapError(toError))),
  );
  const regions = yield* expectOk(regionsResponse, "account").pipe(
    Effect.flatMap((body) => decodeRegions(body).pipe(Effect.mapError(toError))),
  );
  const organizations = new Map<string, string>();
  for (const entry of info.tokens ?? []) {
    if (entry.org_slug) organizations.set(entry.org_slug, entry.organization ?? entry.org_slug);
  }
  return {
    organizations: [...organizations].map(([slug, name]) => ({ slug, name })),
    regions: (regions.Regions ?? regions.regions ?? [])
      .filter((region) => !region.deprecated)
      .map(({ code, name }) => ({ code, name }))
      .toSorted((a, b) => a.name.localeCompare(b.name)),
    nearestRegion: regions.nearest ?? null,
  } satisfies CubeFlyAccount;
});

/** A machine's size and identity, whatever it is for. */
interface AppMachineSpec {
  readonly image: string;
  readonly guest: (typeof GUESTS)[CubeSize];
  readonly metadata: Record<string, string>;
  readonly environment: CubeMachineSpec["environment"];
}

/**
 * The cube home: one small machine, `t3-home-<id>`, that manages cubes from
 * Fly so they need no computer of the user's to be on. It runs the cube image
 * without a repository and sleeps when no one is using it. It is never listed,
 * claimed, or pruned as a cube.
 */
export interface FlyHome {
  readonly app: string;
  readonly httpBaseUrl: string;
}

/** One change to a machine's state, as Fly records it. */
export type FlyMachineEvent = typeof MachineEvent.Type;

export interface FlyCubeDriver extends CubeDriver {
  /**
   * A cube machine's latest events, at most 50 in any order: when it was
   * started, suspended, or stopped (`status` is `started`, `suspended`, and
   * so on), with epoch-millisecond timestamps.
   */
  readonly events: (id: CubeId) => Effect.Effect<ReadonlyArray<FlyMachineEvent>, CubeError>;
  /** The organization's cube home, if one was made. */
  readonly findHome: Effect.Effect<FlyHome | null, CubeError>;
  /** Makes and boots a cube home; its server may still be starting when this returns. */
  readonly createHome: (spec: {
    readonly id: CubeId;
    readonly environmentId: EnvironmentId;
    readonly image: string;
    readonly environment: CubeMachineSpec["environment"];
  }) => Effect.Effect<FlyHome, CubeError>;
  /** Runs a command as the image's user in the cube home. */
  readonly execHome: (
    home: FlyHome,
    command: ReadonlyArray<string>,
  ) => Effect.Effect<string, CubeError>;
}

/**
 * A server that only manages cubes, with room for the `t3` commands run in it
 * beside the server (512 MB ran out), and small enough to suspend.
 */
const HOME_GUEST = { cpu_kind: "shared", cpus: 1, memory_mb: 1024 } as const;

export const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const call = makeCall(yield* HttpClient.HttpClient);

  /** Token, organization, and region; null when Fly is not set up. */
  const configured = settings.getSettings.pipe(
    Effect.map(({ cubeFly }) => (cubeFly.apiToken && cubeFly.organization ? cubeFly : null)),
    Effect.mapError(() => new CubeUnavailableError({ reason: "Settings could not be read." })),
  );
  const requireConfigured = configured.pipe(
    Effect.flatMap((fly) =>
      fly
        ? Effect.succeed(fly)
        : Effect.fail(
            new CubeUnavailableError({
              reason: "Add a Fly API token and organization in Settings.",
            }),
          ),
    ),
  );

  const decodeOr =
    <A>(decode: (input: unknown) => Effect.Effect<A, Schema.SchemaError>) =>
    (operation: CubeOperation, id?: CubeId) =>
    (body: unknown) =>
      decode(body).pipe(
        Effect.mapError((cause) => new CubeOperationError({ operation, id, cause })),
      );

  /** An app's one machine; not found once the app is gone. */
  const machineOf = (token: string, app: string, operation: CubeOperation, id?: CubeId) =>
    call(token, "GET", `/v1/apps/${app}/machines`, operation, id).pipe(
      Effect.flatMap((response) =>
        response.status === 404
          ? Effect.fail(new CubeNotFoundError({ id: id ?? app }))
          : expectOk(response, operation, id).pipe(
              Effect.flatMap(decodeOr(decodeAppMachines)(operation, id)),
              Effect.flatMap(([machine]) =>
                machine
                  ? Effect.succeed(machine)
                  : Effect.fail(new CubeNotFoundError({ id: id ?? app })),
              ),
            ),
      ),
    );

  /** Fly holds each wait for at most a minute and answers 408 when it runs out. */
  const waitFor = Effect.fn("FlyCubeDriver.waitFor")(function* (
    token: string,
    app: string,
    machineId: string,
    state: "started" | "stopped" | "suspended",
    operation: CubeOperation,
    id?: CubeId,
  ) {
    for (let waited = 0; waited < START_TIMEOUT_SECONDS; waited += WAIT_SECONDS) {
      const response = yield* call(
        token,
        "GET",
        `/v1/apps/${app}/machines/${machineId}/wait?state=${state}&timeout=${WAIT_SECONDS}`,
        operation,
        id,
      );
      if (response.status !== 408) return yield* expectOk(response, operation, id);
    }
    return yield* new CubeOperationError({
      operation,
      id,
      cause: `The machine was not ${state} after ${START_TIMEOUT_SECONDS} seconds.`,
    });
  });

  /** Every machine in the organization, across pages. */
  const listMachines = (fly: { readonly apiToken: string; readonly organization: string }) =>
    Effect.gen(function* () {
      const machines: MachineSummary[] = [];
      let cursor: string | null | undefined;
      do {
        const query = `include_deleted=false${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const page = yield* call(
          fly.apiToken,
          "GET",
          `/v1/orgs/${encodeURIComponent(fly.organization)}/machines?${query}`,
          "list",
        ).pipe(
          Effect.flatMap((response) => expectOk(response, "list")),
          Effect.flatMap(decodeOr(decodeOrgMachines)("list")),
        );
        machines.push(...(page.machines ?? []).filter((machine) => machine.state !== "destroyed"));
        cursor = page.next_cursor;
      } while (cursor);
      return machines;
    });

  /**
   * Makes an app with its own addresses and one booted machine that a request
   * wakes. A half-built app is deleted, including when this is interrupted.
   */
  const createApp = Effect.fn("FlyCubeDriver.createApp")(function* (
    app: string,
    spec: AppMachineSpec,
    operation: CubeOperation,
    id?: CubeId,
  ) {
    const fly = yield* requireConfigured;
    const post = (path: string, body: unknown) =>
      call(fly.apiToken, "POST", path, operation, id, body).pipe(
        Effect.flatMap((response) => expectOk(response, operation, id)),
      );

    yield* post("/v1/apps", { name: app, org_slug: fly.organization });
    yield* Effect.gen(function* () {
      yield* post(`/v1/apps/${app}/ip_assignments`, { type: "shared_v4" });
      yield* post(`/v1/apps/${app}/ip_assignments`, { type: "v6" });
      const secrets = Object.fromEntries(
        spec.environment.filter((v) => v.sensitive).map((v) => [v.name, v.value]),
      );
      const secretsVersion =
        Object.keys(secrets).length === 0
          ? undefined
          : (yield* post(`/v1/apps/${app}/secrets`, { values: secrets }).pipe(
              Effect.flatMap(decodeOr(decodeSecretsVersion)(operation, id)),
            )).version;
      const machine = yield* post(`/v1/apps/${app}/machines`, {
        name: "cube",
        ...(fly.region ? { region: fly.region } : {}),
        ...(secretsVersion === undefined ? {} : { min_secrets_version: secretsVersion }),
        config: {
          image: spec.image,
          env: Object.fromEntries(
            spec.environment.filter((v) => !v.sensitive).map((v) => [v.name, v.value]),
          ),
          guest: spec.guest,
          rootfs: { persist: "always" },
          // The server exits when it has been idle and cannot suspend, which
          // must stop the machine rather than restart it.
          restart: { policy: "no" },
          metadata: spec.metadata,
          services: [
            {
              protocol: "tcp",
              internal_port: CUBE_PORT,
              // A request wakes a sleeping machine; clients connect only when
              // they need it, and the machine sleeps itself when idle.
              autostart: true,
              autostop: "off",
              ports: [
                { port: 443, handlers: ["tls", "http"] },
                { port: 80, handlers: ["http"], force_https: true },
              ],
            },
          ],
        },
      }).pipe(
        Effect.catchIf(
          (error) => String(error.cause).includes("failed to get manifest"),
          () =>
            Effect.fail(
              new CubeUnavailableError({
                reason: `Fly could not find the image ${spec.image}. Fly pulls images from a registry, so set the cube image to a registry reference such as registry.fly.io/<app>:latest.`,
              }),
            ),
        ),
        Effect.flatMap(decodeOr(decodeMachine)(operation, id)),
      );
      yield* waitFor(fly.apiToken, app, machine.id, "started", operation, id);
    }).pipe(
      // A half-built app would keep billing for its IPs and machine.
      Effect.onError(() =>
        call(fly.apiToken, "DELETE", `/v1/apps/${app}`, operation, id).pipe(Effect.ignore),
      ),
    );
  });

  /** Runs a command as the image's `dev` user; Fly itself execs as root. */
  const execIn = Effect.fn("FlyCubeDriver.exec")(function* (
    app: string,
    command: ReadonlyArray<string>,
    operation: CubeOperation,
    id?: CubeId,
  ) {
    const fly = yield* requireConfigured;
    const machine = yield* machineOf(fly.apiToken, app, operation, id);
    const result = yield* call(
      fly.apiToken,
      "POST",
      `/v1/apps/${app}/machines/${machine.id}/exec`,
      operation,
      id,
      {
        // A login shell as `dev` gets the image user's PATH and home.
        command: ["su", "-l", "dev", "-c", shellJoin(command)],
        timeout: 60,
      },
    ).pipe(
      Effect.flatMap((response) => expectOk(response, operation, id)),
      Effect.flatMap(decodeOr(decodeExec)(operation, id)),
    );
    if ((result.exit_code ?? 0) !== 0) {
      return yield* new CubeOperationError({ operation, id, cause: result.stderr ?? "" });
    }
    return result.stdout ?? "";
  });

  const list: CubeDriver["list"] = Effect.gen(function* () {
    const fly = yield* configured;
    if (!fly) return [];
    return (yield* listMachines(fly)).flatMap((machine) => {
      const cube = machine.app_name ? toMachine(machine.app_name, machine) : null;
      return cube ? [cube] : [];
    });
  });

  const find: CubeDriver["find"] = (id, operation) =>
    configured.pipe(
      Effect.flatMap((fly) =>
        fly
          ? machineOf(fly.apiToken, appName(id), operation, id).pipe(
              Effect.flatMap((machine) => {
                const cube = toMachine(appName(id), machine);
                return cube ? Effect.succeed(cube) : Effect.fail(new CubeNotFoundError({ id }));
              }),
            )
          : Effect.fail(new CubeNotFoundError({ id })),
      ),
    );

  const create: CubeDriver["create"] = (spec) =>
    createApp(
      appName(spec.id),
      {
        image: spec.image,
        guest: GUESTS[spec.size],
        metadata: {
          t3code_cube: "1",
          t3code_cube_label: spec.label,
          t3code_cube_environment: spec.environmentId,
          ...(spec.spare === null ? {} : { [SPARE_METADATA]: spec.spare }),
        },
        environment: spec.environment,
      },
      "create",
      spec.id,
    );

  const start: CubeDriver["start"] = Effect.fn("FlyCubeDriver.start")(function* (id) {
    const fly = yield* requireConfigured;
    const machine = yield* machineOf(fly.apiToken, appName(id), "start", id);
    yield* call(
      fly.apiToken,
      "POST",
      `/v1/apps/${appName(id)}/machines/${machine.id}/start`,
      "start",
      id,
    ).pipe(Effect.flatMap((response) => expectOk(response, "start", id)));
    yield* waitFor(fly.apiToken, appName(id), machine.id, "started", "start", id);
  });

  const stop: CubeDriver["stop"] = Effect.fn("FlyCubeDriver.stop")(function* (id) {
    const fly = yield* requireConfigured;
    const machine = yield* machineOf(fly.apiToken, appName(id), "stop", id);
    yield* call(
      fly.apiToken,
      "POST",
      `/v1/apps/${appName(id)}/machines/${machine.id}/stop`,
      "stop",
      id,
      {
        timeout: "10s",
      },
    ).pipe(Effect.flatMap((response) => expectOk(response, "stop", id)));
    yield* waitFor(fly.apiToken, appName(id), machine.id, "stopped", "stop", id);
  });

  const park: CubeDriver["park"] = Effect.fn("FlyCubeDriver.park")(function* (id) {
    const fly = yield* requireConfigured;
    const machine = yield* machineOf(fly.apiToken, appName(id), "park", id);
    const path = `/v1/apps/${appName(id)}/machines/${machine.id}`;
    const suspended = yield* call(fly.apiToken, "POST", `${path}/suspend`, "park", id);
    if (suspended.status >= 200 && suspended.status < 300) {
      yield* waitFor(fly.apiToken, appName(id), machine.id, "suspended", "park", id);
      return;
    }
    yield* Effect.logInfo("Fly could not suspend a spare cube; stopping it instead", {
      id,
      status: suspended.status,
    });
    yield* call(fly.apiToken, "POST", `${path}/stop`, "park", id, { timeout: "10s" }).pipe(
      Effect.flatMap((response) => expectOk(response, "park", id)),
    );
    yield* waitFor(fly.apiToken, appName(id), machine.id, "stopped", "park", id);
  });

  const claim: CubeDriver["claim"] = Effect.fn("FlyCubeDriver.claim")(function* (id) {
    const fly = yield* requireConfigured;
    const machine = yield* machineOf(fly.apiToken, appName(id), "claim", id);
    yield* call(
      fly.apiToken,
      "DELETE",
      `/v1/apps/${appName(id)}/machines/${machine.id}/metadata/${SPARE_METADATA}`,
      "claim",
      id,
    ).pipe(Effect.flatMap((response) => expectOk(response, "claim", id)));
  });

  const remove: CubeDriver["remove"] = Effect.fn("FlyCubeDriver.remove")(function* (id) {
    const fly = yield* requireConfigured;
    const response = yield* call(fly.apiToken, "DELETE", `/v1/apps/${appName(id)}`, "remove", id);
    if (response.status !== 404) yield* expectOk(response, "remove", id);
  });

  const removeIfStopped: CubeDriver["removeIfStopped"] = Effect.fn("FlyCubeDriver.removeIfStopped")(
    function* (id) {
      const fly = yield* requireConfigured;
      const machine = yield* machineOf(fly.apiToken, appName(id), "remove", id);
      // Without `force`, Fly refuses to destroy a started machine, so a wake
      // that lands after this cube was found idle keeps it.
      const destroyed = yield* call(
        fly.apiToken,
        "DELETE",
        `/v1/apps/${appName(id)}/machines/${machine.id}`,
        "remove",
        id,
      );
      if (destroyed.status < 200 || destroyed.status >= 300) {
        yield* Effect.logInfo("Fly kept a cube that is no longer idle", {
          id,
          status: destroyed.status,
        });
        return false;
      }
      // Only now that the machine is gone does the app go, with its IPs.
      yield* remove(id);
      return true;
    },
  );

  const exec: CubeDriver["exec"] = (id, command, operation) =>
    execIn(appName(id), command, operation, id);

  const events: FlyCubeDriver["events"] = Effect.fn("FlyCubeDriver.events")(function* (id) {
    const fly = yield* requireConfigured;
    const machine = yield* machineOf(fly.apiToken, appName(id), "usage", id);
    return yield* call(
      fly.apiToken,
      "GET",
      // Fly's maximum; listing the machines only carries the last five.
      `/v1/apps/${appName(id)}/machines/${machine.id}/events?limit=50`,
      "usage",
      id,
    ).pipe(
      Effect.flatMap((response) => expectOk(response, "usage", id)),
      Effect.flatMap(decodeOr(decodeMachineEvents)("usage", id)),
    );
  });

  const homeOf = (app: string): FlyHome => ({ app, httpBaseUrl: `https://${app}.fly.dev` });

  const findHome: FlyCubeDriver["findHome"] = Effect.gen(function* () {
    const fly = yield* requireConfigured;
    const app = (yield* listMachines(fly)).find((machine) =>
      machine.app_name?.startsWith(HOME_PREFIX),
    )?.app_name;
    return app === undefined ? null : homeOf(app);
  });

  const createHome: FlyCubeDriver["createHome"] = Effect.fn("FlyCubeDriver.createHome")(
    function* (spec) {
      const app = `${HOME_PREFIX}${spec.id}`;
      yield* createApp(
        app,
        {
          image: spec.image,
          guest: HOME_GUEST,
          metadata: { t3code_home: "1", t3code_home_environment: spec.environmentId },
          environment: spec.environment,
        },
        "home",
      );
      return homeOf(app);
    },
  );

  return {
    list,
    find,
    create,
    start,
    stop,
    park,
    claim,
    remove,
    removeIfStopped,
    exec,
    events,
    findHome,
    createHome,
    execHome: (home, command) => execIn(home.app, command, "home"),
  } satisfies FlyCubeDriver;
});
