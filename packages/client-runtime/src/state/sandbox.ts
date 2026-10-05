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

import type { ConnectionCatalogEntry, ConnectWhen } from "../connection/catalog.ts";
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
      connectWhen: sandboxConnectWhen(sandbox),
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
 * Fly sandboxes connect only when needed: a sleeping one wakes when something
 * connects, so a client must not retry it in the background. Docker sandboxes
 * cannot wake on request and keep an ordinary connection.
 */
export const sandboxConnectWhen = (sandbox: Pick<SandboxSummary, "backend">): ConnectWhen =>
  sandbox.backend === "fly" ? "needed" : "always";

/**
 * How this client's saved connection to a sandbox should change to match it.
 * A Fly sandbox stays switched on whatever its state and connects when
 * needed. A Docker sandbox's connection is switched off while it is stopped,
 * so the client stops retrying it, and back on once it is serving again,
 * whoever woke it.
 */
export function sandboxConnectionChange(
  entry: Pick<ConnectionCatalogEntry, "enabled" | "connectWhen"> | undefined,
  sandbox: Pick<SandboxSummary, "backend" | "state" | "httpBaseUrl">,
): { readonly enabled?: boolean; readonly connectWhen?: ConnectWhen } {
  if (entry === undefined) return {};
  if (sandboxConnectWhen(sandbox) === "needed") {
    return {
      ...(entry.connectWhen === "needed" ? {} : { connectWhen: "needed" as const }),
      ...(entry.enabled ? {} : { enabled: true }),
    };
  }
  if (sandbox.state !== "running") return entry.enabled ? { enabled: false } : {};
  return sandbox.httpBaseUrl !== null && !entry.enabled ? { enabled: true } : {};
}

/**
 * Brings this client's view of a host's sandboxes up to date and returns
 * them: serving sandboxes are registered or re-addressed, connections follow
 * each sandbox's state, and connections to deleted sandboxes are forgotten. A sandbox that fails to register is skipped
 * and retried on the next sync.
 */
export const syncSandboxEnvironments = Effect.fn("clientRuntime.sandbox.syncEnvironments")(
  function* (hostEnvironmentId: EnvironmentId) {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const sandboxes = yield* registry.run(hostEnvironmentId, request(WS_METHODS.sandboxList, {}));
    // A sandbox deleted anywhere (another device, the CLI, automatic removal)
    // leaves this client a connection that can never connect again.
    const removed = yield* registry
      .run(hostEnvironmentId, request(WS_METHODS.sandboxRemovedEnvironments, {}))
      .pipe(Effect.orElseSucceed((): ReadonlyArray<EnvironmentId> => []));
    const knownBeforeRemoval = yield* SubscriptionRef.get(registry.entries);
    yield* Effect.forEach(
      removed.filter((environmentId) => knownBeforeRemoval.has(environmentId)),
      (environmentId) => registry.remove(environmentId).pipe(Effect.ignore),
      { discard: true },
    );
    const entries = yield* SubscriptionRef.get(registry.entries);
    yield* Effect.forEach(
      sandboxes,
      (sandbox) => {
        const environmentId = sandbox.environmentId;
        if (environmentId === null) return Effect.void;
        const change = sandboxConnectionChange(entries.get(environmentId), sandbox);
        return Effect.all(
          [
            change.connectWhen === undefined
              ? Effect.void
              : registry.setConnectWhen(environmentId, change.connectWhen),
            change.enabled === undefined
              ? Effect.void
              : registry.setEnabled(environmentId, change.enabled),
          ],
          { discard: true },
        ).pipe(Effect.ignore);
      },
      { discard: true },
    );
    yield* Effect.forEach(
      sandboxes.filter((sandbox) => sandbox.state === "running" && sandbox.httpBaseUrl !== null),
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
 * sandboxes afterwards. Stopping first closes this client's connection to it
 * (see `sandboxConnectionChange`), starting connects at its new address, and
 * deleting forgets it, since its environment is gone.
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
      const environmentId = yield* ensureSandboxEnvironment(hostEnvironmentId, started);
      // Starting it is a need: connect now rather than when next used.
      yield* registry.ensureConnected(environmentId, "60 seconds").pipe(Effect.ignore);
      break;
    }
    case "stop":
      if (sandbox.environmentId !== null) {
        // A Fly sandbox wakes when something connects, so close this client's
        // connection first; a Docker one is switched off until it is started.
        yield* sandboxConnectWhen(sandbox) === "needed"
          ? registry.disconnect(sandbox.environmentId)
          : registry.setEnabled(sandbox.environmentId, false).pipe(Effect.ignore);
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
