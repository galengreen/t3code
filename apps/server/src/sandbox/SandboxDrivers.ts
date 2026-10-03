import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DockerSandboxDriver from "./DockerSandboxDriver.ts";
import * as FlySandboxDriver from "./FlySandboxDriver.ts";
import { SandboxDrivers } from "./SandboxDriver.ts";

/** Every backend's driver; each one stays inert until its backend is set up. */
export const layer = Layer.effect(
  SandboxDrivers,
  Effect.all({ docker: DockerSandboxDriver.make, fly: FlySandboxDriver.make }),
);
