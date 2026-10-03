import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse, UrlParams } from "effect/unstable/http";

import * as ServerSettings from "../serverSettings.ts";
import * as FlySandboxDriver from "./FlySandboxDriver.ts";

const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

interface FakeApp {
  readonly secrets: Record<string, string>;
  readonly ips: string[];
  machines: Array<{ id: string; state: string; config: Record<string, unknown> }>;
}

/** A tiny Machines API that keeps apps in memory and records each call. */
const fakeFly = (options: { failMachineCreate?: boolean; waitTimeouts?: number } = {}) => {
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
      const [, , resource, app, sub, machineId, action] = path.split("/");
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
      if (action === "wait") {
        if (waitTimeouts > 0) {
          waitTimeouts -= 1;
          return reply(408, { error: "deadline_exceeded" });
        }
        return reply(200, { ok: true });
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
  use: (driver: Effect.Success<typeof FlySandboxDriver.make>) => Effect.Effect<A, E>,
  sandboxFly = { apiToken: "FlyV1 fm2_secret", organization: "personal", region: "syd" },
) =>
  FlySandboxDriver.make.pipe(
    Effect.flatMap(use),
    Effect.provide(ServerSettings.layerTest({ sandboxFly })),
    Effect.provideService(HttpClient.HttpClient, fly.client),
  );

const spec = {
  id: "abc123def456",
  label: "Fix login",
  image: "registry.fly.io/t3-sandbox:latest",
  size: "small" as const,
  environment: [
    { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-ant-oat-secret", sensitive: true },
    { name: "REPO_URL", value: "https://github.com/example/app.git", sensitive: false },
  ],
};

describe("FlySandboxDriver", () => {
  it.effect("creates one app per sandbox with secrets kept out of the machine config", () => {
    const fly = fakeFly();
    return run(fly, (driver) =>
      Effect.gen(function* () {
        yield* driver.create(spec);
        const app = fly.apps.get("t3-sbx-abc123def456")!;
        expect(app.ips).toEqual(["shared_v4", "v6"]);
        expect(app.secrets).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-secret" });
        const create = fly.calls.find((call) => call.path.endsWith("/machines") && call.body)!;
        expect(create.body).toMatchObject({
          region: "syd",
          min_secrets_version: 3,
          config: {
            image: spec.image,
            env: { REPO_URL: "https://github.com/example/app.git" },
            guest: { cpu_kind: "shared", cpus: 2, memory_mb: 2048 },
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
            httpBaseUrl: "https://t3-sbx-abc123def456.fly.dev",
          },
        ]);
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
        expect(error._tag).toBe("SandboxOperationError");
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
          "https://t3-sbx-abc123def456.fly.dev",
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
        expect(missing._tag).toBe("SandboxNotFoundError");
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
          expect(error._tag).toBe("SandboxUnavailableError");
          expect(fly.calls).toEqual([]);
        }),
      { apiToken: "", organization: "", region: "" },
    );
  });

  it.effect("reads a token's organizations and Fly's regions as the API sends them", () =>
    Effect.gen(function* () {
      const account = yield* FlySandboxDriver.flyAccount("FlyV1 fm2_secret").pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json(
                  request.url.endsWith("/v1/tokens/current")
                    ? { tokens: [{ org_slug: "t3-sandboxes", organization: "T3 Sandboxes" }] }
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
        organizations: [{ slug: "t3-sandboxes", name: "T3 Sandboxes" }],
        regions: [
          { code: "ams", name: "Amsterdam, Netherlands" },
          { code: "syd", name: "Sydney, Australia" },
        ],
        nearestRegion: "syd",
      });
    }),
  );

  it("sends macaroons with their scheme and other tokens as bearer tokens", () => {
    expect(FlySandboxDriver.flyAuthorization("FlyV1 fm2_abc,fm2_def")).toBe(
      "FlyV1 fm2_abc,fm2_def",
    );
    expect(FlySandboxDriver.flyAuthorization("fm2_abc")).toBe("FlyV1 fm2_abc");
    expect(FlySandboxDriver.flyAuthorization("plain-token")).toBe("Bearer plain-token");
  });
});
