/**
 * Runs sandboxes as Fly Machines, through the Machines API with the user's own
 * Fly token, organization, and region from settings.
 *
 * Each sandbox is its own Fly app, `t3-sbx-<id>`, holding one machine, so it
 * gets its own `https://<app>.fly.dev` address and deleting the app removes
 * everything it owns. Fly's proxy wakes a sleeping machine when a request
 * arrives, so the address is always given and connecting is how clients wake
 * a sandbox; the machine decides for itself when to sleep. The machine keeps its root filesystem across stops, so
 * the image's home directory and everything written to it persist like a
 * Docker sandbox's volume. Sensitive variables become Fly app secrets, which
 * Fly encrypts and injects as environment variables; plain ones go into the
 * machine config. The app list is the record: apps are found by name prefix.
 *
 * Fly runs `exec` as root, so commands are run as the image's `dev` user.
 *
 * A spare carries `t3code_sandbox_spare` metadata, which claiming deletes; Fly
 * changes metadata without restarting the machine. Parking suspends it, which
 * keeps memory and so the booted server, and resumes in about a second. Fly
 * only suspends machines of up to 2 GB, so larger ones are stopped instead.
 */
import {
  EnvironmentId,
  SandboxNotFoundError,
  SandboxOperationError,
  SandboxUnavailableError,
  type SandboxFlyAccount,
  type SandboxId,
  type SandboxSize,
  type SandboxState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import * as ServerSettings from "../serverSettings.ts";
import type { SandboxDriver, SandboxMachine, SandboxOperation } from "./SandboxDriver.ts";

const API_BASE = "https://api.machines.dev";
const APP_PREFIX = "t3-sbx-";
const SPARE_METADATA = "t3code_sandbox_spare";
const SANDBOX_PORT = 7777;
/** The first start in a region pulls the image, which can take minutes. */
const START_TIMEOUT_SECONDS = 300;
const WAIT_SECONDS = 60;

const appName = (id: SandboxId) => `${APP_PREFIX}${id}`;

const GUESTS: Record<
  SandboxSize,
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
  config: Schema.optional(
    Schema.Struct({
      image: Schema.optional(Schema.String),
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

const sandboxState = (state: string): SandboxState =>
  state === "started" ? "running" : state === "failed" ? "failed" : "stopped";

const toMachine = (app: string, machine: MachineSummary): SandboxMachine | null => {
  if (!app.startsWith(APP_PREFIX)) return null;
  const id = app.slice(APP_PREFIX.length);
  const state = sandboxState(machine.state);
  return {
    id,
    label: machine.config?.metadata?.t3code_sandbox_label ?? id,
    environmentId: machine.config?.metadata?.t3code_sandbox_environment
      ? EnvironmentId.make(machine.config.metadata.t3code_sandbox_environment)
      : null,
    image: machine.config?.image ?? "",
    state,
    createdAt: machine.created_at ?? "",
    stoppedAt: state === "stopped" ? (machine.updated_at ?? null) : null,
    httpBaseUrl: `https://${app}.fly.dev`,
    spare: machine.config?.metadata?.[SPARE_METADATA] ?? null,
  };
};

interface FlyResponse {
  readonly status: number;
  /** Parsed JSON, or null when the body is empty or not JSON. */
  readonly body: unknown;
  readonly text: string;
}

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** One Machines API call; transport failures become `SandboxOperationError`. */
const makeCall =
  (client: HttpClient.HttpClient) =>
  (
    token: string,
    method: "GET" | "POST" | "DELETE",
    path: string,
    operation: SandboxOperation,
    id?: SandboxId,
    body?: unknown,
  ): Effect.Effect<FlyResponse, SandboxOperationError | SandboxUnavailableError> => {
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
        Effect.mapError((cause) => new SandboxOperationError({ operation, id, cause })),
        Effect.flatMap((response) =>
          response.status === 401
            ? Effect.fail(
                new SandboxUnavailableError({
                  reason: "Fly rejected the API token. Check it in Settings.",
                }),
              )
            : Effect.succeed(response),
        ),
      );
  };

const expectOk = (
  response: FlyResponse,
  operation: SandboxOperation,
  id?: SandboxId,
): Effect.Effect<unknown, SandboxOperationError> =>
  response.status >= 200 && response.status < 300
    ? Effect.succeed(response.body)
    : Effect.fail(
        new SandboxOperationError({
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
export const flyAccount = Effect.fn("FlySandboxDriver.account")(function* (token: string) {
  const call = makeCall(yield* HttpClient.HttpClient);
  const [tokenResponse, regionsResponse] = yield* Effect.all(
    [
      call(token, "GET", "/v1/tokens/current", "account"),
      call(token, "GET", "/v1/platform/regions", "account"),
    ],
    { concurrency: 2 },
  );
  const toError = (cause: unknown) => new SandboxOperationError({ operation: "account", cause });
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
  } satisfies SandboxFlyAccount;
});

export const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const call = makeCall(yield* HttpClient.HttpClient);

  /** Token, organization, and region; null when Fly is not set up. */
  const configured = settings.getSettings.pipe(
    Effect.map(({ sandboxFly }) =>
      sandboxFly.apiToken && sandboxFly.organization ? sandboxFly : null,
    ),
    Effect.mapError(() => new SandboxUnavailableError({ reason: "Settings could not be read." })),
  );
  const requireConfigured = configured.pipe(
    Effect.flatMap((fly) =>
      fly
        ? Effect.succeed(fly)
        : Effect.fail(
            new SandboxUnavailableError({
              reason: "Add a Fly API token and organization in Settings.",
            }),
          ),
    ),
  );

  const decodeOr =
    <A>(decode: (input: unknown) => Effect.Effect<A, Schema.SchemaError>) =>
    (operation: SandboxOperation, id?: SandboxId) =>
    (body: unknown) =>
      decode(body).pipe(
        Effect.mapError((cause) => new SandboxOperationError({ operation, id, cause })),
      );

  /** The sandbox's one machine; not found once its app is gone. */
  const machineOf = (token: string, id: SandboxId, operation: SandboxOperation) =>
    call(token, "GET", `/v1/apps/${appName(id)}/machines`, operation, id).pipe(
      Effect.flatMap((response) =>
        response.status === 404
          ? Effect.fail(new SandboxNotFoundError({ id }))
          : expectOk(response, operation, id).pipe(
              Effect.flatMap(decodeOr(decodeAppMachines)(operation, id)),
              Effect.flatMap(([machine]) =>
                machine ? Effect.succeed(machine) : Effect.fail(new SandboxNotFoundError({ id })),
              ),
            ),
      ),
    );

  /** Fly holds each wait for at most a minute and answers 408 when it runs out. */
  const waitFor = Effect.fn("FlySandboxDriver.waitFor")(function* (
    token: string,
    id: SandboxId,
    machineId: string,
    state: "started" | "stopped" | "suspended",
    operation: SandboxOperation,
  ) {
    for (let waited = 0; waited < START_TIMEOUT_SECONDS; waited += WAIT_SECONDS) {
      const response = yield* call(
        token,
        "GET",
        `/v1/apps/${appName(id)}/machines/${machineId}/wait?state=${state}&timeout=${WAIT_SECONDS}`,
        operation,
        id,
      );
      if (response.status !== 408) return yield* expectOk(response, operation, id);
    }
    return yield* new SandboxOperationError({
      operation,
      id,
      cause: `The machine was not ${state} after ${START_TIMEOUT_SECONDS} seconds.`,
    });
  });

  const list: SandboxDriver["list"] = Effect.gen(function* () {
    const fly = yield* configured;
    if (!fly) return [];
    const machines: SandboxMachine[] = [];
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
      for (const machine of page.machines ?? []) {
        const sandbox = machine.app_name ? toMachine(machine.app_name, machine) : null;
        if (sandbox && machine.state !== "destroyed") machines.push(sandbox);
      }
      cursor = page.next_cursor;
    } while (cursor);
    return machines;
  });

  const find: SandboxDriver["find"] = (id, operation) =>
    configured.pipe(
      Effect.flatMap((fly) =>
        fly
          ? machineOf(fly.apiToken, id, operation).pipe(
              Effect.flatMap((machine) => {
                const sandbox = toMachine(appName(id), machine);
                return sandbox
                  ? Effect.succeed(sandbox)
                  : Effect.fail(new SandboxNotFoundError({ id }));
              }),
            )
          : Effect.fail(new SandboxNotFoundError({ id })),
      ),
    );

  const create: SandboxDriver["create"] = Effect.fn("FlySandboxDriver.create")(function* (spec) {
    const fly = yield* requireConfigured;
    const app = appName(spec.id);
    const post = (path: string, body: unknown) =>
      call(fly.apiToken, "POST", path, "create", spec.id, body).pipe(
        Effect.flatMap((response) => expectOk(response, "create", spec.id)),
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
              Effect.flatMap(decodeOr(decodeSecretsVersion)("create", spec.id)),
            )).version;
      const machine = yield* post(`/v1/apps/${app}/machines`, {
        name: "sandbox",
        ...(fly.region ? { region: fly.region } : {}),
        ...(secretsVersion === undefined ? {} : { min_secrets_version: secretsVersion }),
        config: {
          image: spec.image,
          env: Object.fromEntries(
            spec.environment.filter((v) => !v.sensitive).map((v) => [v.name, v.value]),
          ),
          guest: GUESTS[spec.size],
          rootfs: { persist: "always" },
          // The sandbox's server exits when it has been idle, which must stop
          // the machine rather than restart it.
          restart: { policy: "no" },
          metadata: {
            t3code_sandbox: "1",
            t3code_sandbox_label: spec.label,
            t3code_sandbox_environment: spec.environmentId,
            ...(spec.spare === null ? {} : { [SPARE_METADATA]: spec.spare }),
          },
          services: [
            {
              protocol: "tcp",
              internal_port: SANDBOX_PORT,
              // A request wakes a sleeping sandbox; clients connect only when
              // they need it, and the sandbox sleeps itself when idle.
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
              new SandboxUnavailableError({
                reason: `Fly could not find the image ${spec.image}. Fly pulls images from a registry, so set the sandbox image to a registry reference such as registry.fly.io/<app>:latest.`,
              }),
            ),
        ),
        Effect.flatMap(decodeOr(decodeMachine)("create", spec.id)),
      );
      yield* waitFor(fly.apiToken, spec.id, machine.id, "started", "create");
    }).pipe(
      // A half-built app would keep billing for its IPs and machine, so take it
      // down, including when the create is interrupted.
      Effect.onError(() =>
        call(fly.apiToken, "DELETE", `/v1/apps/${app}`, "create", spec.id).pipe(Effect.ignore),
      ),
    );
  });

  const start: SandboxDriver["start"] = Effect.fn("FlySandboxDriver.start")(function* (id) {
    const fly = yield* requireConfigured;
    const machine = yield* machineOf(fly.apiToken, id, "start");
    yield* call(
      fly.apiToken,
      "POST",
      `/v1/apps/${appName(id)}/machines/${machine.id}/start`,
      "start",
      id,
    ).pipe(Effect.flatMap((response) => expectOk(response, "start", id)));
    yield* waitFor(fly.apiToken, id, machine.id, "started", "start");
  });

  const stop: SandboxDriver["stop"] = Effect.fn("FlySandboxDriver.stop")(function* (id) {
    const fly = yield* requireConfigured;
    const machine = yield* machineOf(fly.apiToken, id, "stop");
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
    yield* waitFor(fly.apiToken, id, machine.id, "stopped", "stop");
  });

  const park: SandboxDriver["park"] = Effect.fn("FlySandboxDriver.park")(function* (id) {
    const fly = yield* requireConfigured;
    const machine = yield* machineOf(fly.apiToken, id, "park");
    const path = `/v1/apps/${appName(id)}/machines/${machine.id}`;
    const suspended = yield* call(fly.apiToken, "POST", `${path}/suspend`, "park", id);
    if (suspended.status >= 200 && suspended.status < 300) {
      yield* waitFor(fly.apiToken, id, machine.id, "suspended", "park");
      return;
    }
    yield* Effect.logInfo("Fly could not suspend a spare sandbox; stopping it instead", {
      id,
      status: suspended.status,
    });
    yield* call(fly.apiToken, "POST", `${path}/stop`, "park", id, { timeout: "10s" }).pipe(
      Effect.flatMap((response) => expectOk(response, "park", id)),
    );
    yield* waitFor(fly.apiToken, id, machine.id, "stopped", "park");
  });

  const claim: SandboxDriver["claim"] = Effect.fn("FlySandboxDriver.claim")(function* (id) {
    const fly = yield* requireConfigured;
    const machine = yield* machineOf(fly.apiToken, id, "claim");
    yield* call(
      fly.apiToken,
      "DELETE",
      `/v1/apps/${appName(id)}/machines/${machine.id}/metadata/${SPARE_METADATA}`,
      "claim",
      id,
    ).pipe(Effect.flatMap((response) => expectOk(response, "claim", id)));
  });

  const remove: SandboxDriver["remove"] = Effect.fn("FlySandboxDriver.remove")(function* (id) {
    const fly = yield* requireConfigured;
    const response = yield* call(fly.apiToken, "DELETE", `/v1/apps/${appName(id)}`, "remove", id);
    if (response.status !== 404) yield* expectOk(response, "remove", id);
  });

  const removeIfStopped: SandboxDriver["removeIfStopped"] = Effect.fn(
    "FlySandboxDriver.removeIfStopped",
  )(function* (id) {
    const fly = yield* requireConfigured;
    const machine = yield* machineOf(fly.apiToken, id, "remove");
    // Without `force`, Fly refuses to destroy a started machine, so a wake
    // that lands after this sandbox was found idle keeps it.
    const destroyed = yield* call(
      fly.apiToken,
      "DELETE",
      `/v1/apps/${appName(id)}/machines/${machine.id}`,
      "remove",
      id,
    );
    if (destroyed.status < 200 || destroyed.status >= 300) {
      yield* Effect.logInfo("Fly kept a sandbox that is no longer idle", {
        id,
        status: destroyed.status,
      });
      return false;
    }
    // Only now that the machine is gone does the app go, with its IPs.
    yield* remove(id);
    return true;
  });

  const exec: SandboxDriver["exec"] = Effect.fn("FlySandboxDriver.exec")(
    function* (id, command, operation) {
      const fly = yield* requireConfigured;
      const machine = yield* machineOf(fly.apiToken, id, operation);
      const result = yield* call(
        fly.apiToken,
        "POST",
        `/v1/apps/${appName(id)}/machines/${machine.id}/exec`,
        operation,
        id,
        {
          // Fly execs as root; a login shell as `dev` gets the image user's PATH and home.
          command: ["su", "-l", "dev", "-c", shellJoin(command)],
          timeout: 60,
        },
      ).pipe(
        Effect.flatMap((response) => expectOk(response, operation, id)),
        Effect.flatMap(decodeOr(decodeExec)(operation, id)),
      );
      if ((result.exit_code ?? 0) !== 0) {
        return yield* new SandboxOperationError({ operation, id, cause: result.stderr ?? "" });
      }
      return result.stdout ?? "";
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
  } satisfies SandboxDriver;
});
