/**
 * Where sandboxes run. A driver creates, starts, stops, and removes the
 * machines behind sandboxes and runs commands inside them. `SandboxService`
 * owns everything that is the same wherever a sandbox runs: settings, ids,
 * readiness, environment variables, and pairing.
 *
 * A driver's own records are the source of truth (container labels for
 * Docker, machine metadata for Fly), so the host persists nothing about a
 * sandbox. Every backend's driver is live at once, so sandboxes made before
 * the user switched backends can still be listed, stopped, and removed.
 */
import type {
  EnvironmentId,
  SandboxBackend,
  SandboxError,
  SandboxId,
  SandboxOperationError,
  SandboxSize,
  SandboxState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export type SandboxOperation = SandboxOperationError["operation"];

export interface SandboxMachine {
  readonly id: SandboxId;
  readonly label: string;
  readonly image: string;
  readonly state: SandboxState;
  readonly createdAt: string;
  /**
   * The environment the sandbox's server serves, recorded when it was created;
   * null for sandboxes made before it was recorded.
   */
  readonly environmentId: EnvironmentId | null;
  /** Where clients reach the sandbox's T3 server, while it runs. */
  readonly httpBaseUrl: string | null;
}

export interface SandboxVariable {
  readonly name: string;
  readonly value: string;
  /** Sensitive values must stay out of command lines and plain machine config. */
  readonly sensitive: boolean;
}

export interface SandboxMachineSpec {
  readonly id: SandboxId;
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly image: string;
  readonly size: SandboxSize;
  /** Later entries win when names repeat. */
  readonly environment: ReadonlyArray<SandboxVariable>;
}

export interface SandboxDriver {
  /** Empty when the backend is not set up, rather than failing. */
  readonly list: Effect.Effect<ReadonlyArray<SandboxMachine>, SandboxError>;
  /** Fails with `SandboxNotFoundError` for ids this driver does not know. */
  readonly find: (
    id: SandboxId,
    operation: SandboxOperation,
  ) => Effect.Effect<SandboxMachine, SandboxError>;
  /** Creates and boots a machine; its server may still be starting when this returns. */
  readonly create: (spec: SandboxMachineSpec) => Effect.Effect<void, SandboxError>;
  readonly start: (id: SandboxId) => Effect.Effect<void, SandboxError>;
  /** Stops the machine, keeping its files. */
  readonly stop: (id: SandboxId) => Effect.Effect<void, SandboxError>;
  /** Deletes the machine and its files. */
  readonly remove: (id: SandboxId) => Effect.Effect<void, SandboxError>;
  /** Runs a command as the image's user in a running machine and returns its standard output. */
  readonly exec: (
    id: SandboxId,
    command: ReadonlyArray<string>,
    operation: SandboxOperation,
  ) => Effect.Effect<string, SandboxError>;
}

export class SandboxDrivers extends Context.Service<
  SandboxDrivers,
  Readonly<Record<SandboxBackend, SandboxDriver>>
>()("t3/sandbox/SandboxDriver/SandboxDrivers") {}
