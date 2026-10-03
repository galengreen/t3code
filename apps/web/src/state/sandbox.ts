import {
  createSandboxEnvironmentAtoms,
  launchSandboxEnvironment,
  syncSandboxEnvironments,
} from "@t3tools/client-runtime/state/sandbox";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, SandboxCreateInput } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const sandboxEnvironment = createSandboxEnvironmentAtoms(connectionAtomRuntime);

const sandboxScheduler = createAtomCommandScheduler();

/** Registers a host's running sandboxes and refreshes their addresses. */
export const syncSandboxes = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:sandbox:sync",
  scheduler: sandboxScheduler,
  concurrency: {
    mode: "singleFlight",
    key: (hostEnvironmentId: EnvironmentId) => hostEnvironmentId,
  },
  execute: (hostEnvironmentId: EnvironmentId) => syncSandboxEnvironments(hostEnvironmentId),
});

/** Creates a sandbox on a host and registers it, returning its environment. */
export const launchSandbox = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:sandbox:launch",
  execute: (input: {
    readonly hostEnvironmentId: EnvironmentId;
    readonly sandbox: SandboxCreateInput;
  }) => launchSandboxEnvironment(input.hostEnvironmentId, input.sandbox),
});
