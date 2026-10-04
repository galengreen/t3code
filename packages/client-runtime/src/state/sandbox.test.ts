import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { BearerConnectionProfile } from "../connection/catalog.ts";
import { BearerConnectionTarget, RelayConnectionTarget } from "../connection/model.ts";
import {
  findSandboxByEnvironment,
  sandboxConnectionChange,
  sandboxRegistrationAction,
} from "./sandbox.ts";

const environmentId = EnvironmentId.make("env-sandbox");
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

describe("sandboxRegistrationAction", () => {
  it("registers a sandbox this client has never seen", () => {
    expect(sandboxRegistrationAction(undefined, "http://100.64.0.7:32770")).toEqual({
      kind: "register",
    });
  });

  it("moves a saved sandbox to the new port Docker gave it on restart", () => {
    expect(
      sandboxRegistrationAction(bearerEntry("http://100.64.0.7:32770"), "http://100.64.0.7:32771"),
    ).toEqual({ kind: "update", httpBaseUrl: "http://100.64.0.7:32771", label: "Fix login" });
  });

  it("does not reconnect a sandbox whose saved address only adds a trailing slash", () => {
    expect(
      sandboxRegistrationAction(
        bearerEntry("https://t3-sbx-abc.fly.dev/"),
        "https://t3-sbx-abc.fly.dev",
      ),
    ).toEqual({ kind: "none" });
  });

  it("leaves an up-to-date or non-bearer connection alone", () => {
    expect(
      sandboxRegistrationAction(bearerEntry("http://100.64.0.7:32770"), "http://100.64.0.7:32770"),
    ).toEqual({ kind: "none" });
    expect(
      sandboxRegistrationAction(
        {
          target: new RelayConnectionTarget({ environmentId, label: "Relay" }),
          profile: Option.none(),
        },
        "http://100.64.0.7:32770",
      ),
    ).toEqual({ kind: "none" });
  });
});

describe("findSandboxByEnvironment", () => {
  const sandbox = (id: string, env: string | null) => ({
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
    [hostA, [sandbox("aaaaaaaaaaaa", null)]],
    [hostB, [sandbox("bbbbbbbbbbbb", "env-sandbox")]],
  ]);

  it("finds a stopped sandbox by the environment it serves, with its host", () => {
    expect(findSandboxByEnvironment(lists, environmentId)).toMatchObject({
      hostEnvironmentId: hostB,
      sandbox: { id: "bbbbbbbbbbbb", state: "stopped" },
    });
  });

  it("treats environments no host knows as ordinary", () => {
    expect(findSandboxByEnvironment(lists, EnvironmentId.make("laptop"))).toBeNull();
  });
});

describe("sandboxConnectionChange", () => {
  const serving = { state: "running" as const, httpBaseUrl: "https://t3-sbx-abc.fly.dev" };
  const booting = { state: "running" as const, httpBaseUrl: null };
  const asleep = { state: "stopped" as const, httpBaseUrl: null };

  it("switches a sleeping sandbox's connection off so the client stops retrying it", () => {
    expect(sandboxConnectionChange({ enabled: true }, asleep)).toBe("disable");
    expect(sandboxConnectionChange({ enabled: false }, asleep)).toBe("none");
  });

  it("switches it back on once the sandbox serves again, whoever woke it", () => {
    expect(sandboxConnectionChange({ enabled: false }, serving)).toBe("enable");
    expect(sandboxConnectionChange({ enabled: false }, booting)).toBe("none");
    expect(sandboxConnectionChange({ enabled: true }, serving)).toBe("none");
  });

  it("leaves sandboxes this client never registered alone", () => {
    expect(sandboxConnectionChange(undefined, asleep)).toBe("none");
  });
});
