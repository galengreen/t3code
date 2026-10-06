import type { EnvironmentId } from "@t3tools/contracts";
import { syncCubeEnvironments } from "@t3tools/client-runtime/state/cube";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

const cubeScheduler = createAtomCommandScheduler();

/** Registers a host's cubes in this client and forgets deleted ones. */
export const syncCubes = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:cube:sync",
  scheduler: cubeScheduler,
  concurrency: {
    mode: "singleFlight",
    key: (hostEnvironmentId: EnvironmentId) => hostEnvironmentId,
  },
  execute: (hostEnvironmentId: EnvironmentId) => syncCubeEnvironments(hostEnvironmentId),
});
