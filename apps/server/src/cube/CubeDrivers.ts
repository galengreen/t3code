import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DockerCubeDriver from "./DockerCubeDriver.ts";
import * as FlyCubeDriver from "./FlyCubeDriver.ts";
import { CubeDrivers } from "./CubeDriver.ts";

/** Every backend's driver; each one stays inert until its backend is set up. */
export const layer = Layer.effect(
  CubeDrivers,
  Effect.all({ docker: DockerCubeDriver.make, fly: FlyCubeDriver.make }),
);
