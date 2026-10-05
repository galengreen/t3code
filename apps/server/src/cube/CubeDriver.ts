/**
 * Where cubes run. A driver creates, starts, stops, and removes the
 * machines behind cubes and runs commands inside them. `CubeService`
 * owns everything that is the same wherever a cube runs: settings, ids,
 * readiness, environment variables, and pairing.
 *
 * A driver's own records are the source of truth (container labels and names
 * for Docker, machine metadata for Fly), so the host persists nothing about a
 * cube. That includes spares: cubes booted ahead of time and parked
 * until a create claims one. Every backend's driver is live at once, so cubes made before
 * the user switched backends can still be listed, stopped, and removed.
 */
import type {
  EnvironmentId,
  CubeBackend,
  CubeError,
  CubeId,
  CubeOperationError,
  CubeSize,
  CubeState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type { FlyCubeDriver } from "./FlyCubeDriver.ts";
import type * as Effect from "effect/Effect";

export type CubeOperation = CubeOperationError["operation"];

export interface CubeMachine {
  readonly id: CubeId;
  readonly label: string;
  readonly image: string;
  readonly state: CubeState;
  readonly createdAt: string;
  /** When a stopped machine stopped, for deleting long-stopped cubes; null otherwise. */
  readonly stoppedAt: string | null;
  /**
   * The environment the cube's server serves, recorded when it was created;
   * null for cubes made before it was recorded.
   */
  readonly environmentId: EnvironmentId | null;
  /**
   * Where clients reach the cube's T3 server: always for Fly, where the
   * address is fixed and a request wakes a sleeping cube; only while it
   * runs for Docker, which publishes it on a new port each start.
   */
  readonly httpBaseUrl: string | null;
  /** For an unclaimed spare, the settings fingerprint it was made with; null otherwise. */
  readonly spare: string | null;
}

export interface CubeVariable {
  readonly name: string;
  readonly value: string;
  /** Sensitive values must stay out of command lines and plain machine config. */
  readonly sensitive: boolean;
}

export interface CubeMachineSpec {
  readonly id: CubeId;
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly image: string;
  readonly size: CubeSize;
  /** Later entries win when names repeat. */
  readonly environment: ReadonlyArray<CubeVariable>;
  /** Marks the machine as a spare made with this settings fingerprint. */
  readonly spare: string | null;
}

export interface CubeDriver {
  /** Empty when the backend is not set up, rather than failing. */
  readonly list: Effect.Effect<ReadonlyArray<CubeMachine>, CubeError>;
  /** Fails with `CubeNotFoundError` for ids this driver does not know. */
  readonly find: (id: CubeId, operation: CubeOperation) => Effect.Effect<CubeMachine, CubeError>;
  /** Creates and boots a machine; its server may still be starting when this returns. */
  readonly create: (spec: CubeMachineSpec) => Effect.Effect<void, CubeError>;
  readonly start: (id: CubeId) => Effect.Effect<void, CubeError>;
  /** Stops the machine, keeping its files. */
  readonly stop: (id: CubeId) => Effect.Effect<void, CubeError>;
  /**
   * Puts a running spare to sleep the way it wakes fastest, keeping its
   * memory where that is cheap. `start` wakes it.
   */
  readonly park: (id: CubeId) => Effect.Effect<void, CubeError>;
  /** Turns a spare into an ordinary cube. */
  readonly claim: (id: CubeId) => Effect.Effect<void, CubeError>;
  /** Deletes the machine and its files. */
  readonly remove: (id: CubeId) => Effect.Effect<void, CubeError>;
  /**
   * Deletes the machine and its files only if it is not running, as one step
   * the backend enforces, so a cube woken a moment before is never deleted.
   * Succeeds with whether it was deleted.
   */
  readonly removeIfStopped: (id: CubeId) => Effect.Effect<boolean, CubeError>;
  /** Runs a command as the image's user in a running machine and returns its standard output. */
  readonly exec: (
    id: CubeId,
    command: ReadonlyArray<string>,
    operation: CubeOperation,
  ) => Effect.Effect<string, CubeError>;
}

export class CubeDrivers extends Context.Service<
  CubeDrivers,
  // Fly's driver also makes the cube home.
  Readonly<Record<CubeBackend, CubeDriver> & { readonly fly: FlyCubeDriver }>
>()("t3/cube/CubeDriver/CubeDrivers") {}
