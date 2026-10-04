import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SandboxDrivers from "./SandboxDrivers.ts";
import * as SandboxService from "./SandboxService.ts";

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
    Created: "2026-10-03T00:00:00Z",
    Config: { Image: container.image, Labels: container.labels },
    State: { Status: container.status, FinishedAt: container.finishedAt ?? "0001-01-01T00:00:00Z" },
    NetworkSettings: {
      Ports: {
        "7777/tcp":
          container.status === "running" ? [{ HostIp: "127.0.0.1", HostPort: "49999" }] : null,
      },
    },
    Name: name,
  });
  const run = (args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) => {
    calls.push([...args]);
    envs.push(env);
    const [command, ...rest] = args;
    switch (command) {
      case "ps": {
        const [key, value] = rest[rest.indexOf("--filter") + 1]!.replace(/^label=/, "").split("=");
        const ids = [...containers.entries()]
          .filter(([, container]) => container.labels[key!] === value)
          .map(([name]) => name);
        return output(ids.map((id) => `${id}\n`).join(""));
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
        containers.get(rest[0]!)!.status = "running";
        return output("");
      case "stop": {
        const container = containers.get(rest.at(-1)!)!;
        container.status = "exited";
        container.finishedAt = stopTime;
        return output("");
      }
      case "rm":
        containers.delete(rest.at(-1)!);
        return output("");
      case "volume":
        volumes.delete(rest.at(-1)!);
        return output("");
      case "exec":
        return output(
          JSON.stringify({ id: "x", credential: "PAIR1234", expiresAt: "2026-10-03T01:00:00Z" }),
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
    stopAt: (time: string) => {
      stopTime = time;
    },
  };
};

const serviceLayer = (
  docker: ReturnType<typeof fakeDocker>,
  enableSandboxes = true,
  serving: () => boolean = () => true,
) =>
  SandboxService.layer.pipe(
    Layer.provide(SandboxDrivers.layer),
    Layer.provideMerge(
      ServerSettings.layerTest({
        enableSandboxes,
        sandboxImage: "sandbox:test",
        sandboxPublishHost: "100.64.0.7",
        sandboxEnvironment: [
          { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-ant-oat-secret", sensitive: true },
          { name: "GIT_AUTHOR_NAME", value: "Sandbox", sensitive: false },
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
                ? Response.json({ environmentId: "env-sandbox" })
                : new Response(null, { status: 502 }),
            ),
          ),
        ),
      ),
    ),
    Layer.provide(NodeCrypto.layer),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-sandbox-test-" })),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

describe("SandboxService", () => {
  it.effect("creates a labelled container on host loopback and waits for its server", () => {
    const docker = fakeDocker();
    return Effect.gen(function* () {
      const sandboxes = yield* SandboxService.SandboxService;
      const created = yield* sandboxes.create({
        label: "Fix login",
        repositoryUrl: "https://github.com/example/app.git",
      });
      expect(created).toMatchObject({
        label: "Fix login",
        image: "sandbox:test",
        state: "running",
        httpBaseUrl: "http://100.64.0.7:49999",
      });
      expect(created.id).toMatch(/^[0-9a-f]{12}$/);
      // The host chooses the environment id and the image adopts it, so the
      // sandbox can be matched to its threads even while it is stopped.
      expect(created.environmentId).toMatch(/^[0-9a-f-]{36}$/);
      const run = docker.calls.find((args) => args[0] === "run")!;
      expect(run).toEqual(
        expect.arrayContaining([
          "--publish",
          "100.64.0.7::7777/tcp",
          "--env",
          "REPO_URL=https://github.com/example/app.git",
          `t3code.sandbox.id=${created.id}`,
          `t3-sandbox-${created.id}-home:/home/dev`,
          "T3_SANDBOX_LABEL=Fix login",
          `T3_ENVIRONMENT_ID=${created.environmentId}`,
          `t3code.sandbox.environment=${created.environmentId}`,
        ]),
      );
      expect((yield* sandboxes.list).map((sandbox) => sandbox.id)).toEqual([created.id]);
    }).pipe(Effect.provide(serviceLayer(docker)));
  });

  it.effect(
    "starts sandboxes with the host's variables, keeping secrets off the command line",
    () => {
      const docker = fakeDocker();
      return Effect.gen(function* () {
        const sandboxes = yield* SandboxService.SandboxService;
        yield* sandboxes.create({ label: "Fix login" });
        const runIndex = docker.calls.findIndex((args) => args[0] === "run");
        const run = docker.calls[runIndex]!;
        expect(run).toEqual(
          expect.arrayContaining([
            "--env",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "--env",
            "GIT_AUTHOR_NAME=Sandbox",
          ]),
        );
        expect(run.join(" ")).not.toContain("sk-ant-oat-secret");
        expect(docker.envs[runIndex]).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-secret" });
      }).pipe(Effect.provide(serviceLayer(docker)));
    },
  );

  it.effect("stops, restarts, pairs with, and removes a sandbox with its volume", () => {
    const docker = fakeDocker();
    return Effect.gen(function* () {
      const sandboxes = yield* SandboxService.SandboxService;
      const { id } = yield* sandboxes.create({});
      const stopped = yield* sandboxes.stop({ id });
      expect(stopped).toMatchObject({ state: "stopped", httpBaseUrl: null });
      expect(stopped.environmentId).not.toBeNull();
      const paired = yield* sandboxes.pair({ id }).pipe(Effect.flip);
      expect(paired._tag).toBe("SandboxNotRunningError");
      expect((yield* sandboxes.start({ id })).state).toBe("running");
      expect(yield* sandboxes.pair({ id })).toEqual({
        httpBaseUrl: "http://100.64.0.7:49999",
        credential: "PAIR1234",
        expiresAt: "2026-10-03T01:00:00Z",
      });
      const { environmentId } = (yield* sandboxes.list)[0]!;
      yield* sandboxes.remove({ id });
      expect(yield* sandboxes.list).toEqual([]);
      expect(docker.volumes.size).toBe(0);
      // Every client learns the sandbox is gone, so none keeps retrying it.
      expect(yield* sandboxes.removedEnvironments).toEqual([environmentId]);
    }).pipe(Effect.provide(serviceLayer(docker)));
  });

  it.effect("keeps managing Docker sandboxes after new ones move to Fly", () => {
    const docker = fakeDocker();
    return Effect.gen(function* () {
      const sandboxes = yield* SandboxService.SandboxService;
      const settings = yield* ServerSettings.ServerSettingsService;
      const { id } = yield* sandboxes.create({});
      yield* settings.updateSettings({ sandboxBackend: "fly" });
      expect((yield* sandboxes.list).map((sandbox) => [sandbox.id, sandbox.backend])).toEqual([
        [id, "docker"],
      ]);
      // Fly is selected but has no token yet, so new sandboxes cannot go anywhere.
      const error = yield* sandboxes.create({}).pipe(Effect.flip);
      expect(error._tag).toBe("SandboxUnavailableError");
      yield* sandboxes.remove({ id });
      expect(yield* sandboxes.list).toEqual([]);
    }).pipe(Effect.provide(serviceLayer(docker)));
  });

  it.effect("hides a running sandbox's address until its server answers", () => {
    const docker = fakeDocker();
    let serving = false;
    const layer = serviceLayer(docker, true, () => serving);
    return Effect.gen(function* () {
      const sandboxes = yield* SandboxService.SandboxService;
      serving = true;
      const { id, environmentId } = yield* sandboxes.create({});
      serving = false;
      const [booting] = yield* sandboxes.list;
      expect(booting).toMatchObject({ id, state: "running", httpBaseUrl: null, environmentId });
      serving = true;
      expect((yield* sandboxes.list)[0]?.httpBaseUrl).toBe("http://100.64.0.7:49999");
    }).pipe(Effect.provide(layer));
  });

  it.effect("deletes sandboxes stopped longer than the setting allows, and no others", () => {
    const docker = fakeDocker();
    return Effect.gen(function* () {
      const sandboxes = yield* SandboxService.SandboxService;
      const old = yield* sandboxes.create({ label: "old" });
      const recent = yield* sandboxes.create({ label: "recent" });
      const running = yield* sandboxes.create({ label: "running" });
      docker.stopAt("2026-10-01T00:00:00Z");
      yield* sandboxes.stop({ id: old.id });
      docker.stopAt("2026-10-18T00:00:00Z");
      yield* sandboxes.stop({ id: recent.id });
      yield* TestClock.setTime(Date.parse("2026-10-20T00:00:00Z"));

      expect(yield* sandboxes.pruneStopped).toEqual([old.id]);
      expect((yield* sandboxes.list).map((sandbox) => sandbox.label).toSorted()).toEqual([
        "recent",
        "running",
      ]);
      expect(running.state).toBe("running");
    }).pipe(Effect.provide(serviceLayer(docker)));
  });

  it.effect("reports unknown sandboxes and ignores containers it did not create", () => {
    const docker = fakeDocker();
    docker.containers.set("someone-elses", { labels: {}, image: "nginx", status: "running" });
    return Effect.gen(function* () {
      const sandboxes = yield* SandboxService.SandboxService;
      const error = yield* sandboxes.stop({ id: "aaaaaaaaaaaa" }).pipe(Effect.flip);
      expect(error._tag).toBe("SandboxNotFoundError");
      expect(yield* sandboxes.list).toEqual([]);
    }).pipe(Effect.provide(serviceLayer(docker)));
  });

  it.effect("refuses to touch Docker while sandboxes are turned off", () => {
    const docker = fakeDocker();
    return Effect.gen(function* () {
      const sandboxes = yield* SandboxService.SandboxService;
      const error = yield* sandboxes.list.pipe(Effect.flip);
      expect(error._tag).toBe("SandboxUnavailableError");
      expect(docker.calls).toEqual([]);
    }).pipe(Effect.provide(serviceLayer(docker, false)));
  });
});
