/**
 * Where sandboxes run. A driver creates, starts, stops, and removes the
 * machines behind sandboxes and runs commands inside them. `SandboxService`
 * owns everything that is the same wherever a sandbox runs: settings, ids,
 * readiness, environment variables, and pairing.
 *
 * A driver's own records are the source of truth (container labels for
 * Docker), so the host persists nothing about a sandbox.
 */
import type {
  SandboxError,
  SandboxId,
  SandboxOperationError,
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
  readonly label: string;
  readonly image: string;
  /** Later entries win when names repeat. */
  readonly environment: ReadonlyArray<SandboxVariable>;
}

export class SandboxDriver extends Context.Service<
  SandboxDriver,
  {
    readonly list: Effect.Effect<ReadonlyArray<SandboxMachine>, SandboxError>;
    /** Fails with `SandboxNotFoundError` for ids this driver does not know. */
    readonly find: (
      id: SandboxId,
      operation: SandboxOperation,
    ) => Effect.Effect<SandboxMachine, SandboxError>;
    /** Creates and boots a machine; it is not yet serving when this returns. */
    readonly create: (spec: SandboxMachineSpec) => Effect.Effect<void, SandboxError>;
    readonly start: (id: SandboxId) => Effect.Effect<void, SandboxError>;
    /** Stops the machine, keeping its files. */
    readonly stop: (id: SandboxId) => Effect.Effect<void, SandboxError>;
    /** Deletes the machine and its files. */
    readonly remove: (id: SandboxId) => Effect.Effect<void, SandboxError>;
    /** Runs a command in a running machine and returns its standard output. */
    readonly exec: (
      id: SandboxId,
      command: ReadonlyArray<string>,
      operation: SandboxOperation,
    ) => Effect.Effect<string, SandboxError>;
  }
>()("t3/sandbox/SandboxDriver") {}
