import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse, UrlParams } from "effect/unstable/http";

import * as ServerSettings from "../serverSettings.ts";
import * as FlyCubeDriver from "./FlyCubeDriver.ts";

const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

interface FakeApp {
  readonly secrets: Record<string, string>;
  readonly ips: string[];
  machines: Array<{ id: string; state: string; config: Record<string, unknown> }>;
}

/** A tiny Machines API that keeps apps in memory and records each call. */
const fakeFly = (
  options: { failMachineCreate?: boolean; waitTimeouts?: number; refuseSuspend?: boolean } = {},
) => {
  let waitTimeouts = options.waitTimeouts ?? 0;
  const apps = new Map<string, FakeApp>();
  const calls: Array<{ method: string; path: string; body: unknown; authorization: string }> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const path = new URL(request.url).pathname;
      const query = UrlParams.toString(request.urlParams);
      const body =
        request.body._tag === "Uint8Array"
          ? (parseJson(new TextDecoder().decode(request.body.body)) as any)
          : undefined;
      calls.push({
        method: request.method,
        path: query ? `${path}?${query}` : path,
        body,
        authorization: request.headers.authorization ?? "",
      });
      const reply = (status: number, json?: unknown) =>
        HttpClientResponse.fromWeb(
          request,
          json === undefined ? new Response(null, { status }) : Response.json(json, { status }),
        );
      const [, , resource, app, sub, machineId, action, key] = path.split("/");
      if (resource === "apps" && app === undefined && request.method === "POST") {
        apps.set(body.name, { secrets: {}, ips: [], machines: [] });
        return reply(201, { id: body.name });
      }
      if (resource === "orgs") {
        return reply(200, {
          machines: [...apps].flatMap(([name, entry]) =>
            entry.machines.map((machine) => ({ ...machine, app_name: name })),
          ),
        });
      }
      const entry = app ? apps.get(app) : undefined;
      if (!entry) return reply(404, { error: "not found" });
      if (sub === undefined && request.method === "DELETE") {
        apps.delete(app!);
        return reply(202);
      }
      if (sub === "ip_assignments") {
        entry.ips.push(body.type);
        return reply(200, { ip: "1.2.3.4" });
      }
      if (sub === "secrets") {
        Object.assign(entry.secrets, body.values);
        return reply(200, { version: 3 });
      }
      if (sub === "machines" && machineId === undefined) {
        if (request.method === "GET") return reply(200, entry.machines);
        if (options.failMachineCreate) return reply(422, { error: "image not found" });
        const machine = {
          id: "m1",
          state: "started",
          created_at: "2026-10-04T00:00:00Z",
          config: body.config,
        };
        entry.machines.push(machine);
        return reply(200, machine);
      }
      const machine = entry.machines.find((candidate) => candidate.id === machineId);
      if (!machine) return reply(404, { error: "no machine" });
      if (action === undefined && request.method === "DELETE") {
        // Like Fly, refuse to destroy a started machine without `force`.
        if (machine.state === "started" && !query.includes("force=true")) {
          return reply(412, { error: "failed_precondition: machine not stopped" });
        }
        entry.machines = entry.machines.filter((candidate) => candidate !== machine);
        return reply(200, { ok: true });
      }
      if (action === "wait") {
        if (waitTimeouts > 0) {
          waitTimeouts -= 1;
          return reply(408, { error: "deadline_exceeded" });
        }
        return reply(200, { ok: true });
      }
      if (action === "suspend") {
        if (options.refuseSuspend) return reply(422, { error: "memory too large to suspend" });
        machine.state = "suspended";
      }
      if (action === "metadata" && request.method === "DELETE") {
        const metadata = machine.config.metadata as Record<string, string>;
        delete metadata[key!];
      }
      if (action === "stop") machine.state = "stopped";
      if (action === "start") machine.state = "started";
      if (action === "exec") {
        return reply(200, {
          exit_code: 0,
          stdout: toJson({ credential: "PAIR", expiresAt: "later" }),
        });
      }
      return reply(200, {});
    }),
  );
  return { apps, calls, client };
};

const run = <A, E>(
  fly: ReturnType<typeof fakeFly>,
  use: (driver: Effect.Success<typeof FlyCubeDriver.make>) => Effect.Effect<A, E>,
  cubeFly = { apiToken: "FlyV1 fm2_secret", organization: "personal", region: "syd" },
) =>
  FlyCubeDriver.make.pipe(
    Effect.flatMap(use),
    Effect.provide(ServerSettings.layerTest({ cubeFly })),
    Effect.provideService(HttpClient.HttpClient, fly.client),
  );

const spec = {
  id: "abc123def456",
  environmentId: EnvironmentId.make("2f6c0c1e-9d0a-4b7e-8f53-1f0c2a7d9b10"),
  label: "Fix login",
  image: "registry.fly.io/t3-cube:latest",
  size: "small" as const,
  environment: [
    { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-ant-oat-secret", sensitive: true },
    { name: "T3_HOST", value: "0.0.0.0", sensitive: false },
  ],
  spare: null,
};

describe("FlyCubeDriver", () => {
  it.effect("creates one app per cube with secrets kept out of the machine config", () => {
    const fly = fakeFly();
    return run(fly, (driver) =>
      Effect.gen(function* () {
        yield* driver.create(spec);
        const app = fly.apps.get("t3-cube-abc123def456")!;
        expect(app.ips).toEqual(["shared_v4", "v6"]);
        expect(app.secrets).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-secret" });
        const create = fly.calls.find((call) => call.path.endsWith("/machines") && call.body)!;
        expect(create.body).toMatchObject({
          region: "syd",
          min_secrets_version: 3,
          config: {
            image: spec.image,
            env: { T3_HOST: "0.0.0.0" },
            guest: { cpu_kind: "shared", cpus: 2, memory_mb: 2048 },
            restart: { policy: "no" },
            services: [expect.objectContaining({ autostart: true, autostop: "off" })],
          },
        });
        expect(toJson(create.body)).not.toContain("sk-ant-oat-secret");
        expect(fly.calls.every((call) => call.authorization === "FlyV1 fm2_secret")).toBe(true);

        expect(yield* driver.list).toEqual([
          {
            id: "abc123def456",
            label: "Fix login",
            image: spec.image,
            state: "running",
            createdAt: "2026-10-04T00:00:00Z",
            stoppedAt: null,
            environmentId: spec.environmentId,
            httpBaseUrl: "https://t3-cube-abc123def456.fly.dev",
            spare: null,
          },
        ]);
      }),
    );
  });

  it.effect("parks a spare by suspending it, and claiming it keeps the machine as it is", () => {
    const fly = fakeFly();
    return run(fly, (driver) =>
      Effect.gen(function* () {
        yield* driver.create({ ...spec, spare: "fingerprint" });
        yield* driver.park(spec.id);
        const [parked] = yield* driver.list;
        expect(parked).toMatchObject({ state: "stopped", spare: "fingerprint" });
        expect(fly.apps.get("t3-cube-abc123def456")!.machines[0]!.state).toBe("suspended");

        yield* driver.claim(spec.id);
        expect((yield* driver.list)[0]?.spare).toBeNull();
        yield* driver.start(spec.id);
        expect((yield* driver.list)[0]?.state).toBe("running");
      }),
    );
  });

  it.effect("deletes only a machine that is not running, so a cube just woken is kept", () => {
    const fly = fakeFly();
    return run(fly, (driver) =>
      Effect.gen(function* () {
        yield* driver.create(spec);
        expect(yield* driver.removeIfStopped(spec.id)).toBe(false);
        expect(fly.apps.has("t3-cube-abc123def456")).toBe(true);

        yield* driver.park(spec.id);
        expect(yield* driver.removeIfStopped(spec.id)).toBe(true);
        expect(fly.apps.has("t3-cube-abc123def456")).toBe(false);
      }),
    );
  });

  it.effect("stops a spare that Fly will not suspend", () => {
    const fly = fakeFly({ refuseSuspend: true });
    return run(fly, (driver) =>
      Effect.gen(function* () {
        yield* driver.create({ ...spec, spare: "fingerprint" });
        yield* driver.park(spec.id);
        expect(fly.apps.get("t3-cube-abc123def456")!.machines[0]!.state).toBe("stopped");
      }),
    );
  });

  it.effect("keeps waiting while Fly says the machine is still starting", () => {
    const fly = fakeFly({ waitTimeouts: 2 });
    return run(fly, (driver) =>
      Effect.gen(function* () {
        yield* driver.create(spec);
        expect(fly.calls.filter((call) => call.path.includes("/wait")).length).toBe(3);
        expect(fly.apps.size).toBe(1);
      }),
    );
  });

  it.effect("deletes the half-built app when its machine cannot be created", () => {
    const fly = fakeFly({ failMachineCreate: true });
    return run(fly, (driver) =>
      Effect.gen(function* () {
        const error = yield* driver.create(spec).pipe(Effect.flip);
        expect(error._tag).toBe("CubeOperationError");
        expect(fly.apps.size).toBe(0);
      }),
    );
  });

  it.effect("stops, starts, runs commands as the image user, and removes the app", () => {
    const fly = fakeFly();
    return run(fly, (driver) =>
      Effect.gen(function* () {
        yield* driver.create(spec);
        yield* driver.stop(spec.id);
        expect((yield* driver.find(spec.id, "stop")).state).toBe("stopped");
        yield* driver.start(spec.id);
        expect((yield* driver.find(spec.id, "start")).httpBaseUrl).toBe(
          "https://t3-cube-abc123def456.fly.dev",
        );
        yield* driver.exec(
          spec.id,
          ["t3", "auth", "pairing", "create", "--label", "it's me"],
          "pair",
        );
        const exec = fly.calls.find((call) => call.path.endsWith("/exec"))!;
        expect(exec.body).toMatchObject({
          command: [
            "su",
            "-l",
            "dev",
            "-c",
            `'t3' 'auth' 'pairing' 'create' '--label' 'it'\\''s me'`,
          ],
        });
        yield* driver.remove(spec.id);
        expect(fly.apps.size).toBe(0);
        const missing = yield* driver.find(spec.id, "start").pipe(Effect.flip);
        expect(missing._tag).toBe("CubeNotFoundError");
      }),
    );
  });

  it.effect("lists nothing and calls nobody until Fly is set up", () => {
    const fly = fakeFly();
    return run(
      fly,
      (driver) =>
        Effect.gen(function* () {
          expect(yield* driver.list).toEqual([]);
          const error = yield* driver.create(spec).pipe(Effect.flip);
          expect(error._tag).toBe("CubeUnavailableError");
          expect(fly.calls).toEqual([]);
        }),
      { apiToken: "", organization: "", region: "" },
    );
  });

  it.effect("reads a token's organizations and Fly's regions as the API sends them", () =>
    Effect.gen(function* () {
      const account = yield* FlyCubeDriver.flyAccount("FlyV1 fm2_secret").pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json(
                  request.url.endsWith("/v1/tokens/current")
                    ? { tokens: [{ org_slug: "t3-cubes", organization: "T3 Cubes" }] }
                    : {
                        Regions: [
                          { code: "syd", name: "Sydney, Australia", deprecated: false },
                          { code: "bom", name: "Mumbai, India", deprecated: true },
                          { code: "ams", name: "Amsterdam, Netherlands", deprecated: false },
                        ],
                        nearest: "syd",
                      },
                ),
              ),
            ),
          ),
        ),
      );
      expect(account).toEqual({
        organizations: [{ slug: "t3-cubes", name: "T3 Cubes" }],
        regions: [
          { code: "ams", name: "Amsterdam, Netherlands" },
          { code: "syd", name: "Sydney, Australia" },
        ],
        nearestRegion: "syd",
      });
    }),
  );

  it("sends macaroons with their scheme and other tokens as bearer tokens", () => {
    expect(FlyCubeDriver.flyAuthorization("FlyV1 fm2_abc,fm2_def")).toBe("FlyV1 fm2_abc,fm2_def");
    expect(FlyCubeDriver.flyAuthorization("fm2_abc")).toBe("FlyV1 fm2_abc");
    expect(FlyCubeDriver.flyAuthorization("plain-token")).toBe("Bearer plain-token");
  });

  it.effect("makes a small cube home that is never listed as a cube", () => {
    const fly = fakeFly();
    return run(fly, (driver) =>
      Effect.gen(function* () {
        expect(yield* driver.findHome).toBeNull();
        const home = yield* driver.createHome({
          id: "home12345678",
          environmentId: spec.environmentId,
          image: spec.image,
          environment: [{ name: "T3CODE_SLEEP_WHEN_UNUSED_MINUTES", value: "5", sensitive: false }],
        });
        expect(home).toEqual({
          app: "t3-home-home12345678",
          httpBaseUrl: "https://t3-home-home12345678.fly.dev",
        });
        const create = fly.calls.find((call) => call.path.endsWith("/machines") && call.body)!;
        expect(create.body).toMatchObject({
          config: {
            guest: { cpu_kind: "shared", cpus: 1, memory_mb: 1024 },
            env: { T3CODE_SLEEP_WHEN_UNUSED_MINUTES: "5" },
            services: [expect.objectContaining({ autostart: true })],
          },
        });
        expect(yield* driver.list).toEqual([]);
        expect(yield* driver.findHome).toEqual(home);
      }),
    );
  });
});
