import type { EnvironmentId } from "@t3tools/contracts";
import { syncSandboxEnvironments } from "@t3tools/client-runtime/state/sandbox";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

const sandboxScheduler = createAtomCommandScheduler();

/** Registers a host's sandboxes in this client and forgets deleted ones. */
export const syncSandboxes = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:sandbox:sync",
  scheduler: sandboxScheduler,
  concurrency: {
    mode: "singleFlight",
    key: (hostEnvironmentId: EnvironmentId) => hostEnvironmentId,
  },
  execute: (hostEnvironmentId: EnvironmentId) => syncSandboxEnvironments(hostEnvironmentId),
});
