import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { BearerConnectionProfile } from "../connection/catalog.ts";
import { BearerConnectionTarget, RelayConnectionTarget } from "../connection/model.ts";
import { sandboxRegistrationAction } from "./sandbox.ts";

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
