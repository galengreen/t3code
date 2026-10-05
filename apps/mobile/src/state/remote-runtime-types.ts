import { type EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { EnvironmentId, ThreadId, type ServerConfig } from "@t3tools/contracts";

export interface EnvironmentRuntimeState {
  readonly connectionState: EnvironmentConnectionPhase;
  readonly connectionError: string | null;
  readonly connectionErrorTraceId: string | null;
  readonly serverConfig: ServerConfig | null;
}

export interface ConnectedEnvironmentSummary {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly displayUrl: string;
  readonly isRelayManaged: boolean;
  /** False when the user switched the environment off in Settings. */
  readonly isEnabled: boolean;
  /** Connects only when needed (a cube): not being connected is its normal, idle state. */
  readonly connectsWhenNeeded: boolean;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly connectionError: string | null;
  readonly connectionErrorTraceId: string | null;
}

export interface SelectedThreadRef {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}
