/**
 * Cube - Schemas for isolated environments that a host environment creates
 * on demand, one per task.
 *
 * A cube is a machine (a Docker container or a cloud VM) running its own
 * T3 server, so it is a complete environment once a client pairs with it. The host only creates, starts,
 * stops, and removes cubes and mints pairing credentials for them; it
 * never runs work inside one.
 *
 * @module Cube
 */
import { Schema } from "effect";

import { EnvironmentId, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const CubeId = TrimmedNonEmptyString.check(Schema.isPattern(/^[a-z0-9]{8,32}$/));
export type CubeId = typeof CubeId.Type;

export const CubeState = Schema.Literals(["running", "stopped", "failed"]);
export type CubeState = typeof CubeState.Type;

export const CubeSummary = Schema.Struct({
  id: CubeId,
  /** Where it runs, which may differ from where new cubes go now. */
  backend: Schema.Literals(["docker", "fly"]),
  label: Schema.String,
  image: Schema.String,
  state: CubeState,
  createdAt: Schema.String,
  /** When a stopped cube stopped; null while running. */
  stoppedAt: Schema.NullOr(Schema.String),
  /** Where clients reach the cube's server, once it answers; null while stopped or booting. */
  httpBaseUrl: Schema.NullOr(Schema.String),
  /**
   * The cube server's environment, stable across restarts. Known from
   * creation; null only for older cubes that are stopped or still booting.
   */
  environmentId: Schema.NullOr(EnvironmentId),
});
export type CubeSummary = typeof CubeSummary.Type;

export const CubeCreateInput = Schema.Struct({
  /** Cloned into the cube's `~/work` and added as a project once it answers. */
  repositoryUrl: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isPattern(/^(https:\/\/|git@)[^\s]+$/)),
  ),
});
export type CubeCreateInput = typeof CubeCreateInput.Type;

export const CubeIdInput = Schema.Struct({ id: CubeId });
export type CubeIdInput = typeof CubeIdInput.Type;

export const CubePairing = Schema.Struct({
  httpBaseUrl: Schema.String,
  credential: Schema.String,
  expiresAt: Schema.String,
});
export type CubePairing = typeof CubePairing.Type;

export const CubeFlyAccountInput = Schema.Struct({
  /** Checks this token instead of the saved one, before it is saved. */
  apiToken: Schema.optional(TrimmedNonEmptyString),
});
export type CubeFlyAccountInput = typeof CubeFlyAccountInput.Type;

/** What a Fly token can reach, for choosing where cubes go. */
export const CubeFlyAccount = Schema.Struct({
  organizations: Schema.Array(Schema.Struct({ slug: Schema.String, name: Schema.String })),
  regions: Schema.Array(Schema.Struct({ code: Schema.String, name: Schema.String })),
  /** Fly's guess at the region closest to this server. */
  nearestRegion: Schema.NullOr(Schema.String),
});
export type CubeFlyAccount = typeof CubeFlyAccount.Type;

/**
 * Signing cubes in with Claude: the host runs `claude setup-token` and saves
 * the long-lived token it prints as the cubes' CLAUDE_CODE_OAUTH_TOKEN. The
 * terminal output stops before the token, so it never reaches a client.
 */
export const CubeClaudeSignInState = Schema.Struct({
  phase: Schema.Literals(["running", "saved", "failed"]),
  output: Schema.String.check(Schema.isMaxLength(16_384)),
  /** Characters of output so far, so a client can write only what is new. */
  outputOffset: NonNegativeInt,
  /** Why it failed, as a sentence for the user; null otherwise. */
  message: Schema.NullOr(Schema.String),
});
export type CubeClaudeSignInState = typeof CubeClaudeSignInState.Type;

/** Keystrokes and resizes for the sign-in terminal. */
export const CubeClaudeSignInInput = Schema.Struct({
  data: Schema.String.check(Schema.isMaxLength(4_096)),
  size: Schema.optionalKey(
    Schema.Struct({
      cols: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })),
      rows: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 })),
    }),
  ),
});
export type CubeClaudeSignInInput = typeof CubeClaudeSignInInput.Type;

export class CubeUnavailableError extends Schema.TaggedError<CubeUnavailableError>()(
  "CubeUnavailableError",
  { reason: Schema.String },
  { httpApiStatus: 503 },
) {
  /** Reasons are written as whole sentences for the user. */
  override get message(): string {
    return this.reason;
  }
}

export class CubeNotFoundError extends Schema.TaggedError<CubeNotFoundError>()(
  "CubeNotFoundError",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {
  override get message(): string {
    return `Cube ${this.id} was not found.`;
  }
}

export class CubeNotRunningError extends Schema.TaggedError<CubeNotRunningError>()(
  "CubeNotRunningError",
  { id: Schema.String },
  { httpApiStatus: 409 },
) {
  override get message(): string {
    return `Cube ${this.id} is stopped. Start it first.`;
  }
}

export class CubeOperationError extends Schema.TaggedError<CubeOperationError>()(
  "CubeOperationError",
  {
    operation: Schema.Literals([
      "list",
      "create",
      "start",
      "stop",
      "remove",
      "pair",
      "account",
      "park",
      "claim",
      "clone",
      "home",
    ]),
    id: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
  { httpApiStatus: 502 },
) {
  override get message(): string {
    if (this.operation === "account") return "Could not look up the Fly account.";
    if (this.operation === "clone") return "Could not clone the repository into the cube.";
    if (this.operation === "home") return "Could not set up the cube home on Fly.";
    return this.id === undefined
      ? `Could not ${this.operation} cubes.`
      : `Could not ${this.operation} cube ${this.id}.`;
  }
}

export const CubeError = Schema.Union([
  CubeUnavailableError,
  CubeNotFoundError,
  CubeNotRunningError,
  CubeOperationError,
]);
export type CubeError = typeof CubeError.Type;
