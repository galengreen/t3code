import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CubeDrivers from "./CubeDrivers.ts";
import * as CubeService from "./CubeService.ts";

interface FakeContainer {
  readonly labels: Record<string, string>;
  readonly image: string;
  status: string;
  finishedAt?: string;
}

/** A tiny Docker that understands the commands the service issues. */
const fakeDocker = () => {
  const containers = new Map<string, FakeContainer>();
  const volumes = new Set<string>();
  const calls: string[][] = [];
  let stopTime = "2026-10-01T00:00:00Z";
  const failingClones = new Set<string>();
  const envs: Array<NodeJS.ProcessEnv | undefined> = [];
  const output = (stdout: string, code = 0, stderr = "") => ({
    stdout,
    stderr,
    code: code as ProcessRunner.ProcessRunOutput["code"],
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutInvalidUtf8: false,
    stderrInvalidUtf8: false,
  });
  const inspectJson = (name: string, container: FakeContainer) => ({
    Id: name,
    Name: `/${name}`,
    Created: "2026-10-03T00:00:00Z",
    Config: { Image: container.image, Labels: container.labels },
    State: { Status: container.status, FinishedAt: container.finishedAt ?? "0001-01-01T00:00:00Z" },
    NetworkSettings: {
      Ports: {
        "7777/tcp":
          container.status === "running" ? [{ HostIp: "127.0.0.1", HostPort: "49999" }] : null,
      },
    },
  });
  const run = (args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) => {
    calls.push([...args]);
    envs.push(env);
    const [command, ...rest] = args;
    switch (command) {
      case "ps": {
        const [key, value] = rest[rest.indexOf("--filter") + 1]!.replace(/^label=/, "").split("=");
        const matches = [...containers.entries()].filter(
          ([, container]) => container.labels[key!] === value,
        );
        return output(
          matches
            .map(([name, container]) =>
              rest.includes("--format") ? `${name} ${container.status}\n` : `${name}\n`,
            )
            .join(""),
        );
      }
      case "inspect":
        return output(JSON.stringify(rest.map((name) => inspectJson(name, containers.get(name)!))));
      case "run": {
        const name = rest[rest.indexOf("--name") + 1]!;
        const labels: Record<string, string> = {};
        rest.forEach((arg, index) => {
          if (rest[index - 1] === "--label") {
            const [key, ...value] = arg.split("=");
            labels[key!] = value.join("=");
          }
          if (rest[index - 1] === "--volume") volumes.add(arg.split(":")[0]!);
        });
        containers.set(name, { labels, image: rest.at(-1)!, status: "running" });
        return output(`${name}\n`);
      }
      case "start":
      case "unpause":
        containers.get(rest[0]!)!.status = "running";
        return output("");
      case "pause":
        containers.get(rest[0]!)!.status = "paused";
        return output("");
      case "rename": {
        const [from, to] = rest;
        containers.set(to!, containers.get(from!)!);
        containers.delete(from!);
        return output("");
      }
      case "stop": {
        const container = containers.get(rest.at(-1)!)!;
        container.status = "exited";
        container.finishedAt = stopTime;
        return output("");
      }
      case "rm": {
        const name = rest.at(-1)!;
        // Like Docker, refuse to remove a running container without --force.
        if (!rest.includes("--force") && containers.get(name)?.status === "running") {
          return output("", 1, "cannot remove a running container");
        }
        containers.delete(name);
        return output("");
      }
      case "volume":
        volumes.delete(rest.at(-1)!);
        return output("");
      case "exec":
        if (rest.includes("t3-cube-clone") && failingClones.has(rest[2]!)) {
          return output("", 1, "exec request failed: EOF");
        }
        return output(
          rest.includes("t3-cube-clone")
            ? ""
            : JSON.stringify({
                id: "x",
                credential: "PAIR1234",
                expiresAt: "2026-10-03T01:00:00Z",
              }),
        );
      default:
        return output("", 1, `unexpected docker ${command}`);
    }
  };
  return {
    containers,
    volumes,
    calls,
    envs,
    run,
    /** Containers whose clone fails, as a frozen machine's exec does. */
    failingClones,
    stopAt: (time: string) => {
      stopTime = time;
    },
  };
};

const serviceLayer = (
  docker: ReturnType<typeof fakeDocker>,
  enableCubes = true,
  serving: () => boolean = () => true,
  cubeKeepReady = false,
) =>
  CubeService.layer.pipe(
    Layer.provide(CubeDrivers.layer),
    Layer.provideMerge(
      ServerSettings.layerTest({
        enableCubes,
        cubeImage: "cube:test",
        cubePublishHost: "100.64.0.7",
        cubeKeepReady,
        cubeEnvironment: [
          { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-ant-oat-secret", sensitive: true },
          { name: "GIT_AUTHOR_NAME", value: "Cube", sensitive: false },
        ],
      }),
    ),
    Layer.provide(
      Layer.succeed(ProcessRunner.ProcessRunner, {
        run: (input) => Effect.sync(() => docker.run(input.args, input.env)),
      }),
    ),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              serving()
                ? Response.json({ environmentId: "env-cube" })
                : new Response(null, { status: 502 }),
            ),
          ),
        ),
      ),
    ),
    Layer.provide(NodeCrypto.layer),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-cube-test-" })),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

/** Refills the spare, letting a new one settle (a minute) before it is parked. */
const refillSpare = (cubes: CubeService.CubeService["Service"]) =>
  Effect.gen(function* () {
    const refill = yield* Effect.forkChild(cubes.keepSpareReady);
    yield* TestClock.adjust("2 minutes");
    yield* Fiber.join(refill);
  });

describe("CubeService", () => {
  it.effect(
    "creates a labelled container on host loopback and clones into it once it answers",
    () => {
      const docker = fakeDocker();
      return Effect.gen(function* () {
        const cubes = yield* CubeService.CubeService;
        const created = yield* cubes.create({
          repositoryUrl: "https://github.com/example/app.git",
        });
        expect(created).toMatchObject({
          label: `Cube ${created.id.slice(0, 6)}`,
          image: "cube:test",
          state: "running",
          httpBaseUrl: "http://100.64.0.7:49999",
        });
        expect(created.id).toMatch(/^[0-9a-f]{12}$/);
        // The host chooses the environment id and the image adopts it, so the
        // cube can be matched to its threads even while it is stopped.
        expect(created.environmentId).toMatch(/^[0-9a-f-]{36}$/);
        const run = docker.calls.find((args) => args[0] === "run")!;
        expect(run).toEqual(
          expect.arrayContaining([
            "--publish",
            "100.64.0.7::7777/tcp",
            `t3code.cube.id=${created.id}`,
            `t3-cube-${created.id}-home:/home/dev`,
            `T3_CUBE_LABEL=Cube ${created.id.slice(0, 6)}`,
            `T3_ENVIRONMENT_ID=${created.environmentId}`,
            `t3code.cube.environment=${created.environmentId}`,
          ]),
        );
        expect(docker.calls.at(-1)).toEqual([
          "exec",
          "--user",
          "dev",
          `t3-cube-${created.id}`,
          "t3-cube-clone",
          "https://github.com/example/app.git",
        ]);
        expect((yield* cubes.list).map((cube) => cube.id)).toEqual([created.id]);
      }).pipe(Effect.provide(serviceLayer(docker)));
    },
  );

  it.effect("keeps one spare parked and hands it to the next create", () => {
    const docker = fakeDocker();
    return Effect.gen(function* () {
      const cubes = yield* CubeService.CubeService;
      yield* refillSpare(cubes);
      const [spareName, spare] = [...docker.containers][0]!;
      expect(spareName).toMatch(/^t3-spare-/);
      expect(spare!.status).toBe("paused");
      // Clients never see a spare.
      expect(yield* cubes.list).toEqual([]);

      const created = yield* cubes.create({
        repositoryUrl: "https://github.com/example/app.git",
      });
      expect(spareName).toBe(`t3-spare-${created.id}`);
      expect(docker.containers.get(`t3-cube-${created.id}`)?.status).toBe("running");
      expect(created.state).toBe("running");

      // The claim leaves a new spare in its place.
      yield* refillSpare(cubes);
      const spares = [...docker.containers.keys()].filter((name) => name.startsWith("t3-spare-"));
      expect(spares).toHaveLength(1);
      expect(docker.containers.get(spares[0]!)?.status).toBe("paused");
      expect((yield* cubes.list).map((cube) => cube.id)).toEqual([created.id]);
    }).pipe(Effect.provide(serviceLayer(docker, true, () => true, true)));
  });

  it.effect("replaces a spare that fails once claimed with a fresh cube", () => {
    const docker = fakeDocker();
    return Effect.gen(function* () {
      const cubes = yield* CubeService.CubeService;
      yield* refillSpare(cubes);
      const [spareName] = [...docker.containers.keys()];
      const spareId = spareName!.replace("t3-spare-", "");
      docker.failingClones.add(`t3-cube-${spareId}`);

      const created = yield* cubes.create({
        repositoryUrl: "https://github.com/example/app.git",
      });
      expect(created.id).not.toBe(spareId);
      expect(docker.containers.has(`t3-cube-${spareId}`)).toBe(false);
      expect(docker.containers.get(`t3-cube-${created.id}`)?.status).toBe("running");
    }).pipe(Effect.provide(serviceLayer(docker, true, () => true, true)));
  });

  it.effect("replaces the spare when cube settings change, and deletes it when turned off", () => {
    const docker = fakeDocker();
    return Effect.gen(function* () {
      const cubes = yield* CubeService.CubeService;
      const settings = yield* ServerSettings.ServerSettingsService;
      const spares = () => [...docker.containers.keys()];
      yield* refillSpare(cubes);
      const [first] = spares();
      yield* refillSpare(cubes);
      expect(spares()).toEqual([first]);

      yield* settings.updateSettings({ cubeSize: "medium" });
      yield* refillSpare(cubes);
      expect(spares()).toHaveLength(1);
      expect(spares()[0]).not.toBe(first);

      yield* settings.updateSettings({ cubeKeepReady: false });
      yield* refillSpare(cubes);
      expect(spares()).toEqual([]);
      expect(docker.volumes.size).toBe(0);
    }).pipe(Effect.provide(serviceLayer(docker, true, () => true, true)));
  });

  it.effect("starts cubes with the host's variables, keeping secrets off the command line", () => {
    const docker = fakeDocker();
    return Effect.gen(function* () {
      const cubes = yield* CubeService.CubeService;
      yield* cubes.create({});
      const runIndex = docker.calls.findIndex((args) => args[0] === "run");
      const run = docker.calls[runIndex]!;
      expect(run).toEqual(
        expect.arrayContaining([
          "--env",
          "CLAUDE_CODE_OAUTH_TOKEN",
          "--env",
          "GIT_AUTHOR_NAME=Cube",
        ]),
      );
      expect(run.join(" ")).not.toContain("sk-ant-oat-secret");
      expect(docker.envs[runIndex]).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-secret" });
    }).pipe(Effect.provide(serviceLayer(docker)));
  });

  it.effect("stops, restarts, pairs with, and removes a cube with its volume", () => {
    const docker = fakeDocker();
    return Effect.gen(function* () {
      const cubes = yield* CubeService.CubeService;
      const { id } = yield* cubes.create({});
      const stopped = yield* cubes.stop({ id });
      expect(stopped).toMatchObject({ state: "stopped", httpBaseUrl: null });
      expect(stopped.environmentId).not.toBeNull();
      const paired = yield* cubes.pair({ id }).pipe(Effect.flip);
      expect(paired._tag).toBe("CubeNotRunningError");
      expect((yield* cubes.start({ id })).state).toBe("running");
      expect(yield* cubes.pair({ id })).toEqual({
        httpBaseUrl: "http://100.64.0.7:49999",
        credential: "PAIR1234",
        expiresAt: "2026-10-03T01:00:00Z",
      });
      const { environmentId } = (yield* cubes.list)[0]!;
      yield* cubes.remove({ id });
      expect(yield* cubes.list).toEqual([]);
      expect(docker.volumes.size).toBe(0);
      // Every client learns the cube is gone, so none keeps retrying it.
      expect(yield* cubes.removedEnvironments).toEqual([environmentId]);
    }).pipe(Effect.provide(serviceLayer(docker)));
  });

  it.effect("keeps managing Docker cubes after new ones move to Fly", () => {
    const docker = fakeDocker();
    return Effect.gen(function* () {
      const cubes = yield* CubeService.CubeService;
      const settings = yield* ServerSettings.ServerSettingsService;
      const { id } = yield* cubes.create({});
      yield* settings.updateSettings({ cubeBackend: "fly" });
      expect((yield* cubes.list).map((cube) => [cube.id, cube.backend])).toEqual([[id, "docker"]]);
      // Fly is selected but has no token yet, so new cubes cannot go anywhere.
      const error = yield* cubes.create({}).pipe(Effect.flip);
      expect(error._tag).toBe("CubeUnavailableError");
      yield* cubes.remove({ id });
      expect(yield* cubes.list).toEqual([]);
    }).pipe(Effect.provide(serviceLayer(docker)));
  });

  it.effect("hides a running cube's address until its server answers", () => {
    const docker = fakeDocker();
    let serving = false;
    const layer = serviceLayer(docker, true, () => serving);
    return Effect.gen(function* () {
      const cubes = yield* CubeService.CubeService;
      serving = true;
      const { id, environmentId } = yield* cubes.create({});
      serving = false;
      const [booting] = yield* cubes.list;
      expect(booting).toMatchObject({ id, state: "running", httpBaseUrl: null, environmentId });
      serving = true;
      expect((yield* cubes.list)[0]?.httpBaseUrl).toBe("http://100.64.0.7:49999");
    }).pipe(Effect.provide(layer));
  });

  it.effect("deletes cubes stopped longer than the setting allows, and no others", () => {
    const docker = fakeDocker();
    return Effect.gen(function* () {
      const cubes = yield* CubeService.CubeService;
      const old = yield* cubes.create({});
      const recent = yield* cubes.create({});
      const running = yield* cubes.create({});
      docker.stopAt("2026-10-01T00:00:00Z");
      yield* cubes.stop({ id: old.id });
      docker.stopAt("2026-10-18T00:00:00Z");
      yield* cubes.stop({ id: recent.id });
      yield* TestClock.setTime(Date.parse("2026-10-20T00:00:00Z"));

      expect(yield* cubes.pruneStopped).toEqual([old.id]);
      expect((yield* cubes.list).map((cube) => cube.id).toSorted()).toEqual(
        [recent.id, running.id].toSorted(),
      );
      expect(running.state).toBe("running");
    }).pipe(Effect.provide(serviceLayer(docker)));
  });

  it.effect("reports unknown cubes and ignores containers it did not create", () => {
    const docker = fakeDocker();
    docker.containers.set("someone-elses", { labels: {}, image: "nginx", status: "running" });
    return Effect.gen(function* () {
      const cubes = yield* CubeService.CubeService;
      const error = yield* cubes.stop({ id: "aaaaaaaaaaaa" }).pipe(Effect.flip);
      expect(error._tag).toBe("CubeNotFoundError");
      expect(yield* cubes.list).toEqual([]);
    }).pipe(Effect.provide(serviceLayer(docker)));
  });

  it.effect("refuses to touch Docker while cubes are turned off", () => {
    const docker = fakeDocker();
    return Effect.gen(function* () {
      const cubes = yield* CubeService.CubeService;
      const error = yield* cubes.list.pipe(Effect.flip);
      expect(error._tag).toBe("CubeUnavailableError");
      expect(docker.calls).toEqual([]);
    }).pipe(Effect.provide(serviceLayer(docker, false)));
  });

  describe("createHome", () => {
    const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
    const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
    const FLY = { apiToken: "FlyV1 fm2_secret", organization: "personal", region: "syd" };

    /**
     * Fly, as far as making a home goes, and the home's own server, which
     * takes its settings or, with `refuse`, does not.
     */
    const homeLayer = (refuse: boolean) => {
      const pushed: unknown[] = [];
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          const url = new URL(request.url);
          const body =
            request.body._tag === "Uint8Array"
              ? (parseJson(new TextDecoder().decode(request.body.body)) as any)
              : undefined;
          const reply = (status: number, json?: unknown) =>
            HttpClientResponse.fromWeb(
              request,
              json === undefined ? new Response(null, { status }) : Response.json(json, { status }),
            );
          if (url.hostname.endsWith(".fly.dev")) {
            if (url.pathname === "/api/settings") {
              if (refuse) {
                return reply(500, {
                  _tag: "EnvironmentInternalError",
                  code: "internal_error",
                  reason: "settings_update_failed",
                  traceId: "trace",
                });
              }
              pushed.push({ authorization: request.headers.authorization, body });
              return reply(204);
            }
            return reply(200, { environmentId: "env-home" });
          }
          if (url.pathname.startsWith("/v1/orgs/")) return reply(200, { machines: [] });
          if (url.pathname.endsWith("/machines") && request.method === "POST") {
            return reply(200, { id: "m1", state: "started" });
          }
          if (url.pathname.endsWith("/machines"))
            return reply(200, [{ id: "m1", state: "started" }]);
          if (url.pathname.endsWith("/exec")) {
            const command = (body.command as string[]).at(-1)!;
            return reply(200, {
              exit_code: 0,
              stdout: command.includes("session")
                ? "home-session-token\n"
                : toJson({ credential: "HOMEPAIR", expiresAt: "later" }),
            });
          }
          return reply(200, {});
        }),
      );
      const layer = CubeService.layer.pipe(
        Layer.provide(CubeDrivers.layer),
        Layer.provideMerge(
          ServerSettings.layerTest({
            enableCubes: true,
            cubeBackend: "fly",
            cubeImage: "registry.fly.io/cube:test",
            cubeFly: FLY,
            // As read settings carry a stored secret.
            cubeEnvironment: [
              {
                name: "CLAUDE_CODE_OAUTH_TOKEN",
                value: "sk-ant-oat-secret",
                sensitive: true,
                valueRedacted: true,
              },
            ],
          }),
        ),
        Layer.provide(
          Layer.succeed(ProcessRunner.ProcessRunner, {
            run: () => Effect.die("Docker is not used here"),
          }),
        ),
        Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
        Layer.provide(NodeCrypto.layer),
        Layer.provideMerge(
          Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-cube-test-" })),
        ),
        Layer.provideMerge(NodeServices.layer),
      );
      return { layer, pushed };
    };

    it.effect("hands cube management and the Fly token to the home, then pairs with it", () => {
      const home = homeLayer(false);
      return Effect.gen(function* () {
        const cubes = yield* CubeService.CubeService;
        const pairing = yield* cubes.createHome;
        expect(pairing.httpBaseUrl).toMatch(/^https:\/\/t3-home-[a-z0-9]+\.fly\.dev$/);
        expect(pairing.credential).toBe("HOMEPAIR");
        expect(home.pushed).toEqual([
          {
            authorization: "Bearer home-session-token",
            body: expect.objectContaining({
              enableCubes: true,
              cubeBackend: "fly",
              cubeFly: FLY,
              cubeImage: "registry.fly.io/cube:test",
              cubeEnvironment: [
                { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-ant-oat-secret", sensitive: true },
              ],
            }),
          },
        ]);
        const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
        expect(settings.enableCubes).toBe(false);
        expect(settings.cubeFly.apiToken).toBe("");
      }).pipe(Effect.provide(home.layer));
    });

    it.effect("keeps managing cubes here when the home does not take over", () => {
      const home = homeLayer(true);
      return Effect.gen(function* () {
        const cubes = yield* CubeService.CubeService;
        const error = yield* cubes.createHome.pipe(Effect.flip);
        expect(error._tag).toBe("CubeOperationError");
        const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
        expect(settings.enableCubes).toBe(true);
        expect(settings.cubeFly.apiToken).toBe(FLY.apiToken);
      }).pipe(Effect.provide(home.layer));
    });
  });
});
