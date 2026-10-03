import {
  type EnvironmentId,
  type SandboxCreateInput,
  SandboxNotRunningError,
  type SandboxSummary,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { Atom } from "effect/unstable/reactivity";

import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import * as ConnectionOnboarding from "../connection/onboarding.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import { request } from "../rpc/client.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

/** Commands against a host environment's sandbox service. */
export function createSandboxEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandbox:list",
      tag: WS_METHODS.sandboxList,
    }),
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandbox:create",
      tag: WS_METHODS.sandboxCreate,
    }),
    pair: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandbox:pair",
      tag: WS_METHODS.sandboxPair,
    }),
  };
}

/** What this client must do so a running sandbox is reachable. */
export type SandboxRegistrationAction =
  | { readonly kind: "register" }
  | { readonly kind: "update"; readonly httpBaseUrl: string; readonly label: string }
  | { readonly kind: "none" };

export function sandboxRegistrationAction(
  entry: Pick<ConnectionCatalogEntry, "profile" | "target"> | undefined,
  httpBaseUrl: string,
): SandboxRegistrationAction {
  if (entry === undefined) return { kind: "register" };
  const savedBaseUrl = Option.match(entry.profile, {
    onNone: () => null,
    onSome: (profile) => ("httpBaseUrl" in profile ? profile.httpBaseUrl : null),
  });
  return savedBaseUrl !== null && savedBaseUrl !== httpBaseUrl
    ? { kind: "update", httpBaseUrl, label: entry.target.label }
    : { kind: "none" };
}

/**
 * Makes one running sandbox reachable from this client: registers it on first
 * sight, and otherwise refreshes its saved address, since Docker publishes a
 * sandbox on a new port each time it starts. Returns its environment.
 */
export const ensureSandboxEnvironment = Effect.fn("clientRuntime.sandbox.ensureEnvironment")(
  function* (hostEnvironmentId: EnvironmentId, sandbox: SandboxSummary) {
    if (sandbox.httpBaseUrl === null || sandbox.environmentId === null) {
      return yield* new SandboxNotRunningError({ id: sandbox.id });
    }
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const onboarding = yield* ConnectionOnboarding.ConnectionOnboarding;
    const entry = (yield* SubscriptionRef.get(registry.entries)).get(sandbox.environmentId);
    const action = sandboxRegistrationAction(entry, sandbox.httpBaseUrl);
    if (action.kind === "register") {
      const pairing = yield* registry.run(
        hostEnvironmentId,
        request(WS_METHODS.sandboxPair, { id: sandbox.id }),
      );
      return yield* onboarding.registerPairing({
        host: pairing.httpBaseUrl,
        pairingCode: pairing.credential,
      });
    }
    if (action.kind === "update") {
      yield* onboarding.updateBearer({
        environmentId: sandbox.environmentId,
        label: action.label,
        httpBaseUrl: action.httpBaseUrl,
      });
    }
    return sandbox.environmentId;
  },
);

/**
 * Brings this client's view of a host's sandboxes up to date. A sandbox that
 * fails to register is skipped and retried on the next sync.
 */
export const syncSandboxEnvironments = Effect.fn("clientRuntime.sandbox.syncEnvironments")(
  function* (hostEnvironmentId: EnvironmentId) {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const sandboxes = yield* registry.run(hostEnvironmentId, request(WS_METHODS.sandboxList, {}));
    yield* Effect.forEach(
      sandboxes.filter((sandbox) => sandbox.state === "running"),
      (sandbox) =>
        ensureSandboxEnvironment(hostEnvironmentId, sandbox).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not register sandbox environment.").pipe(
              Effect.annotateLogs({ sandboxId: sandbox.id, cause }),
            ),
          ),
        ),
      { discard: true },
    );
  },
);

/** Creates a sandbox on a host and makes it reachable here, returning its environment. */
export const launchSandboxEnvironment = Effect.fn("clientRuntime.sandbox.launchEnvironment")(
  function* (hostEnvironmentId: EnvironmentId, input: SandboxCreateInput) {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const sandbox = yield* registry.run(
      hostEnvironmentId,
      request(WS_METHODS.sandboxCreate, input),
    );
    return yield* ensureSandboxEnvironment(hostEnvironmentId, sandbox);
  },
);
