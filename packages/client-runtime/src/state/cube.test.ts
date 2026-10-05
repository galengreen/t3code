import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { BearerConnectionProfile } from "../connection/catalog.ts";
import { BearerConnectionTarget, RelayConnectionTarget } from "../connection/model.ts";
import { findCubeByEnvironment, cubeConnectionChange, cubeRegistrationAction } from "./cube.ts";

const environmentId = EnvironmentId.make("env-cube");
const bearerEntry = (httpBaseUrl: string) => ({
  target: new BearerConnectionTarget({ environmentId, label: "Fix login", connectionId: "c" }),
  profile: Option.some(
    new BearerConnectionProfile({
      connectionId: "c",
      environmentId,
      label: "Fix login",
      httpBaseUrl,
      wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
    }),
  ),
});

describe("cubeRegistrationAction", () => {
  it("registers a cube this client has never seen", () => {
    expect(cubeRegistrationAction(undefined, "http://100.64.0.7:32770")).toEqual({
      kind: "register",
    });
  });

  it("moves a saved cube to the new port Docker gave it on restart", () => {
    expect(
      cubeRegistrationAction(bearerEntry("http://100.64.0.7:32770"), "http://100.64.0.7:32771"),
    ).toEqual({ kind: "update", httpBaseUrl: "http://100.64.0.7:32771", label: "Fix login" });
  });

  it("does not reconnect a cube whose saved address only adds a trailing slash", () => {
    expect(
      cubeRegistrationAction(
        bearerEntry("https://t3-cube-abc.fly.dev/"),
        "https://t3-cube-abc.fly.dev",
      ),
    ).toEqual({ kind: "none" });
  });

  it("leaves an up-to-date or non-bearer connection alone", () => {
    expect(
      cubeRegistrationAction(bearerEntry("http://100.64.0.7:32770"), "http://100.64.0.7:32770"),
    ).toEqual({ kind: "none" });
    expect(
      cubeRegistrationAction(
        {
          target: new RelayConnectionTarget({ environmentId, label: "Relay" }),
          profile: Option.none(),
        },
        "http://100.64.0.7:32770",
      ),
    ).toEqual({ kind: "none" });
  });
});

describe("findCubeByEnvironment", () => {
  const cube = (id: string, env: string | null) => ({
    id,
    backend: "fly" as const,
    label: id,
    image: "image",
    state: "stopped" as const,
    createdAt: "2026-10-04T00:00:00Z",
    stoppedAt: "2026-10-04T01:00:00Z",
    httpBaseUrl: null,
    environmentId: env === null ? null : EnvironmentId.make(env),
  });
  const hostA = EnvironmentId.make("host-a");
  const hostB = EnvironmentId.make("host-b");
  const lists = new Map([
    [hostA, [cube("aaaaaaaaaaaa", null)]],
    [hostB, [cube("bbbbbbbbbbbb", "env-cube")]],
  ]);

  it("finds a stopped cube by the environment it serves, with its host", () => {
    expect(findCubeByEnvironment(lists, environmentId)).toMatchObject({
      hostEnvironmentId: hostB,
      cube: { id: "bbbbbbbbbbbb", state: "stopped" },
    });
  });

  it("treats environments no host knows as ordinary", () => {
    expect(findCubeByEnvironment(lists, EnvironmentId.make("laptop"))).toBeNull();
  });
});

describe("cubeConnectionChange", () => {
  const docker = { backend: "docker" as const };
  const serving = { ...docker, state: "running" as const, httpBaseUrl: "http://nas:49999" };
  const booting = { ...docker, state: "running" as const, httpBaseUrl: null };
  const asleep = { ...docker, state: "stopped" as const, httpBaseUrl: null };

  it("switches a sleeping Docker cube's connection off so the client stops retrying it", () => {
    expect(cubeConnectionChange({ enabled: true }, asleep)).toEqual({ enabled: false });
    expect(cubeConnectionChange({ enabled: false }, asleep)).toEqual({});
  });

  it("switches it back on once the cube serves again, whoever woke it", () => {
    expect(cubeConnectionChange({ enabled: false }, serving)).toEqual({ enabled: true });
    expect(cubeConnectionChange({ enabled: false }, booting)).toEqual({});
    expect(cubeConnectionChange({ enabled: true }, serving)).toEqual({});
  });

  it("keeps a Fly cube switched on and connecting only when needed, asleep or not", () => {
    const fly = { backend: "fly" as const, state: "stopped" as const, httpBaseUrl: null };
    expect(cubeConnectionChange({ enabled: true, connectWhen: "needed" }, fly)).toEqual({});
    // Saved by an older client that switched sleeping cubes off.
    expect(cubeConnectionChange({ enabled: false }, fly)).toEqual({
      connectWhen: "needed",
      enabled: true,
    });
  });

  it("leaves cubes this client never registered alone", () => {
    expect(cubeConnectionChange(undefined, asleep)).toEqual({});
  });
});
