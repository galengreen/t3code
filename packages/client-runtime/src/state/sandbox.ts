import {
  type EnvironmentId,
  SandboxNotRunningError,
  type SandboxSummary,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PartitionedSemaphore from "effect/PartitionedSemaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { Atom } from "effect/unstable/reactivity";

import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import * as ConnectionOnboarding from "../connection/onboarding.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import { request } from "../rpc/client.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

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
    /** What the saved Fly token can reach. */
    flyAccount: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:sandbox:fly-account",
      tag: WS_METHODS.sandboxFlyAccount,
    }),
    /** Checks a pasted Fly token before it is saved. */
    checkFlyToken: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandbox:check-fly-token",
      tag: WS_METHODS.sandboxFlyAccount,
    }),
  };
}

/** A sandbox and the host environment that owns it. */
export interface HostedSandbox {
  readonly hostEnvironmentId: EnvironmentId;
  readonly sandbox: SandboxSummary;
}

/**
 * The sandbox serving `environmentId`, from each host's last known list.
 * Null for ordinary environments.
 */
export function findSandboxByEnvironment(
  sandboxesByHost: ReadonlyMap<EnvironmentId, ReadonlyArray<SandboxSummary>>,
  environmentId: EnvironmentId,
): HostedSandbox | null {
  for (const [hostEnvironmentId, sandboxes] of sandboxesByHost) {
    const sandbox = sandboxes.find((candidate) => candidate.environmentId === environmentId);
    if (sandbox) return { hostEnvironmentId, sandbox };
  }
  return null;
}

/** What this client must do so a running sandbox is reachable. */
export type SandboxRegistrationAction =
  | { readonly kind: "register" }
  | { readonly kind: "update"; readonly httpBaseUrl: string; readonly label: string }
  | { readonly kind: "none" };

const sameOrigin = (left: string, right: string) => {
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return left === right;
  }
};

export function sandboxRegistrationAction(
  entry: Pick<ConnectionCatalogEntry, "profile" | "target"> | undefined,
  httpBaseUrl: string,
): SandboxRegistrationAction {
  if (entry === undefined) return { kind: "register" };
  const savedBaseUrl = Option.match(entry.profile, {
    onNone: () => null,
    onSome: (profile) => ("httpBaseUrl" in profile ? profile.httpBaseUrl : null),
  });
  // Saved profiles keep the trailing slash URL parsing adds; comparing raw
  // strings would reconnect a healthy sandbox on every sync.
  return savedBaseUrl !== null && !sameOrigin(savedBaseUrl, httpBaseUrl)
    ? { kind: "update", httpBaseUrl, label: entry.target.label }
    : { kind: "none" };
}

const registerSandboxEnvironment = Effect.fn("clientRuntime.sandbox.ensureEnvironment")(function* (
  hostEnvironmentId: EnvironmentId,
  sandbox: SandboxSummary,
  target: { readonly environmentId: EnvironmentId; readonly httpBaseUrl: string },
) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const onboarding = yield* ConnectionOnboarding.ConnectionOnboarding;
  const entry = (yield* SubscriptionRef.get(registry.entries)).get(target.environmentId);
  const action = sandboxRegistrationAction(entry, target.httpBaseUrl);
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
      environmentId: target.environmentId,
      label: action.label,
      httpBaseUrl: action.httpBaseUrl,
    });
  }
  return target.environmentId;
});

/**
 * One registration at a time per sandbox. A launch and a background sync can
 * both find the same new sandbox; pairing it twice registers it twice, and
 * the second registration replaces the first while it is still connecting.
 */
const registrationLock = PartitionedSemaphore.makeUnsafe<EnvironmentId>({ permits: 1 });

/**
 * Makes one running sandbox reachable from this client: registers it on first
 * sight, and otherwise refreshes its saved address, since Docker publishes a
 * sandbox on a new port each time it starts. Returns its environment.
 */
export const ensureSandboxEnvironment = (
  hostEnvironmentId: EnvironmentId,
  sandbox: SandboxSummary,
) =>
  sandbox.httpBaseUrl === null || sandbox.environmentId === null
    ? Effect.fail(new SandboxNotRunningError({ id: sandbox.id }))
    : registrationLock.withPermit(sandbox.environmentId)(
        registerSandboxEnvironment(hostEnvironmentId, sandbox, {
          environmentId: sandbox.environmentId,
          httpBaseUrl: sandbox.httpBaseUrl,
        }),
      );

/**
 * Brings this client's view of a host's sandboxes up to date and returns
 * them. A sandbox that fails to register is skipped and retried on the next
 * sync.
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
    return sandboxes;
  },
);

export type SandboxChange = "start" | "stop" | "remove";

/**
 * Starts, stops, or deletes a sandbox through its host and returns the host's
 * sandboxes afterwards. Stopping also switches this client's connection to it
 * off: retrying a stopped sandbox would only fail, and a Fly sandbox starts
 * again whenever something connects to it. Starting switches it back on at
 * the sandbox's new address; deleting forgets it, since its environment is gone.
 */
export const changeSandboxEnvironment = Effect.fn("clientRuntime.sandbox.change")(function* (
  hostEnvironmentId: EnvironmentId,
  sandbox: SandboxSummary,
  change: SandboxChange,
) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  switch (change) {
    case "start": {
      const started = yield* registry.run(
        hostEnvironmentId,
        request(WS_METHODS.sandboxStart, { id: sandbox.id }),
      );
      if (started.environmentId !== null) {
        yield* registry.setEnabled(started.environmentId, true).pipe(Effect.ignore);
      }
      yield* ensureSandboxEnvironment(hostEnvironmentId, started);
      break;
    }
    case "stop":
      if (sandbox.environmentId !== null) {
        yield* registry.setEnabled(sandbox.environmentId, false).pipe(Effect.ignore);
      }
      yield* registry.run(hostEnvironmentId, request(WS_METHODS.sandboxStop, { id: sandbox.id }));
      break;
    case "remove":
      yield* registry.run(hostEnvironmentId, request(WS_METHODS.sandboxRemove, { id: sandbox.id }));
      if (sandbox.environmentId !== null) {
        yield* registry.remove(sandbox.environmentId).pipe(Effect.ignore);
      }
      break;
  }
  return yield* registry.run(hostEnvironmentId, request(WS_METHODS.sandboxList, {}));
});
