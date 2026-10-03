/**
 * Sandbox - Schemas for isolated environments that a host environment creates
 * on demand, one per task.
 *
 * A sandbox is a container running its own T3 server, so it is a complete
 * environment once a client pairs with it. The host only creates, starts,
 * stops, and removes sandboxes and mints pairing credentials for them; it
 * never runs work inside one.
 *
 * @module Sandbox
 */
import { Schema } from "effect";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const SandboxId = TrimmedNonEmptyString.check(Schema.isPattern(/^[a-z0-9]{8,32}$/));
export type SandboxId = typeof SandboxId.Type;

export const SandboxState = Schema.Literals(["running", "stopped", "failed"]);
export type SandboxState = typeof SandboxState.Type;

export const SandboxSummary = Schema.Struct({
  id: SandboxId,
  label: Schema.String,
  image: Schema.String,
  state: SandboxState,
  createdAt: Schema.String,
  /** The sandbox server's origin on the host's loopback, while running. */
  httpBaseUrl: Schema.NullOr(Schema.String),
});
export type SandboxSummary = typeof SandboxSummary.Type;

export const SandboxCreateInput = Schema.Struct({
  label: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(80))),
  /** Cloned into the sandbox on first start. */
  repositoryUrl: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isPattern(/^(https:\/\/|git@)[^\s]+$/)),
  ),
});
export type SandboxCreateInput = typeof SandboxCreateInput.Type;

export const SandboxIdInput = Schema.Struct({ id: SandboxId });
export type SandboxIdInput = typeof SandboxIdInput.Type;

export const SandboxPairing = Schema.Struct({
  httpBaseUrl: Schema.String,
  credential: Schema.String,
  expiresAt: Schema.String,
});
export type SandboxPairing = typeof SandboxPairing.Type;

export class SandboxUnavailableError extends Schema.TaggedError<SandboxUnavailableError>()(
  "SandboxUnavailableError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `Sandboxes are unavailable: ${this.reason}`;
  }
}

export class SandboxNotFoundError extends Schema.TaggedError<SandboxNotFoundError>()(
  "SandboxNotFoundError",
  { id: Schema.String },
) {
  override get message(): string {
    return `Sandbox ${this.id} was not found.`;
  }
}

export class SandboxNotRunningError extends Schema.TaggedError<SandboxNotRunningError>()(
  "SandboxNotRunningError",
  { id: Schema.String },
) {
  override get message(): string {
    return `Sandbox ${this.id} is stopped. Start it first.`;
  }
}

export class SandboxOperationError extends Schema.TaggedError<SandboxOperationError>()(
  "SandboxOperationError",
  {
    operation: Schema.Literals(["list", "create", "start", "stop", "remove", "pair"]),
    id: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.id === undefined
      ? `Could not ${this.operation} sandboxes.`
      : `Could not ${this.operation} sandbox ${this.id}.`;
  }
}

export const SandboxError = Schema.Union([
  SandboxUnavailableError,
  SandboxNotFoundError,
  SandboxNotRunningError,
  SandboxOperationError,
]);
export type SandboxError = typeof SandboxError.Type;
