/**
 * Sandbox - Schemas for isolated environments that a host environment creates
 * on demand, one per task.
 *
 * A sandbox is a machine (a Docker container or a cloud VM) running its own
 * T3 server, so it is a complete environment once a client pairs with it. The host only creates, starts,
 * stops, and removes sandboxes and mints pairing credentials for them; it
 * never runs work inside one.
 *
 * @module Sandbox
 */
import { Schema } from "effect";

import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const SandboxId = TrimmedNonEmptyString.check(Schema.isPattern(/^[a-z0-9]{8,32}$/));
export type SandboxId = typeof SandboxId.Type;

export const SandboxState = Schema.Literals(["running", "stopped", "failed"]);
export type SandboxState = typeof SandboxState.Type;

export const SandboxSummary = Schema.Struct({
  id: SandboxId,
  /** Where it runs, which may differ from where new sandboxes go now. */
  backend: Schema.Literals(["docker", "fly"]),
  label: Schema.String,
  image: Schema.String,
  state: SandboxState,
  createdAt: Schema.String,
  /** When a stopped sandbox stopped; null while running. */
  stoppedAt: Schema.NullOr(Schema.String),
  /** Where clients reach the sandbox's server, once it answers; null while stopped or booting. */
  httpBaseUrl: Schema.NullOr(Schema.String),
  /**
   * The sandbox server's environment, stable across restarts. Known from
   * creation; null only for older sandboxes that are stopped or still booting.
   */
  environmentId: Schema.NullOr(EnvironmentId),
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

export const SandboxFlyAccountInput = Schema.Struct({
  /** Checks this token instead of the saved one, before it is saved. */
  apiToken: Schema.optional(TrimmedNonEmptyString),
});
export type SandboxFlyAccountInput = typeof SandboxFlyAccountInput.Type;

/** What a Fly token can reach, for choosing where sandboxes go. */
export const SandboxFlyAccount = Schema.Struct({
  organizations: Schema.Array(Schema.Struct({ slug: Schema.String, name: Schema.String })),
  regions: Schema.Array(Schema.Struct({ code: Schema.String, name: Schema.String })),
  /** Fly's guess at the region closest to this server. */
  nearestRegion: Schema.NullOr(Schema.String),
});
export type SandboxFlyAccount = typeof SandboxFlyAccount.Type;

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
    operation: Schema.Literals(["list", "create", "start", "stop", "remove", "pair", "account"]),
    id: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    if (this.operation === "account") return "Could not look up the Fly account.";
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
