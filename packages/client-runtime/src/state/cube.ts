import {
  type EnvironmentId,
  CubeNotRunningError,
  type CubeSummary,
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
import {
  connectIfNeeded,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

/** Commands against a host environment's cube service. */
export function createCubeEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:cube:list",
      tag: WS_METHODS.cubeList,
    }),
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:cube:create",
      tag: WS_METHODS.cubeCreate,
    }),
    pair: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:cube:pair",
      tag: WS_METHODS.cubePair,
    }),
    /** What the saved Fly token can reach. */
    flyAccount: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:cube:fly-account",
      tag: WS_METHODS.cubeFlyAccount,
    }),
    /** Recorded running time and cost in a window. */
    usage: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:cube:usage",
      tag: WS_METHODS.cubeUsage,
      staleTimeMs: 60_000,
    }),
    /** Checks a pasted Fly token before it is saved. */
    checkFlyToken: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:cube:check-fly-token",
      tag: WS_METHODS.cubeFlyAccount,
    }),
  };
}

/**
 * Runs a request on a cube's host, waking it first if it sleeps until needed
 * (a cube home). Background syncs use `registry.run` instead, which never wakes.
 */
const onHost = <A, E, R>(hostEnvironmentId: EnvironmentId, effect: Effect.Effect<A, E, R>) =>
  connectIfNeeded(hostEnvironmentId).pipe(
    Effect.andThen(
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.run(hostEnvironmentId, effect)),
      ),
    ),
  );

/**
 * Moves cube management from a host to the cube home on Fly, which the host
 * makes if there is none, and saves a connection to the home that connects
 * when needed. Returns the home's environment.
 */
export const createCubeHome = Effect.fn("clientRuntime.cube.createHome")(function* (
  hostEnvironmentId: EnvironmentId,
) {
  const onboarding = yield* ConnectionOnboarding.ConnectionOnboarding;
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const pairing = yield* onHost(hostEnvironmentId, request(WS_METHODS.cubeCreateHome, {}));
  const environmentId = yield* onboarding.registerPairing({
    host: pairing.httpBaseUrl,
    pairingCode: pairing.credential,
    connectWhen: "needed",
  });
  // Its cubes are wanted now, and its settings for showing them.
  yield* registry.ensureConnected(environmentId, "60 seconds").pipe(Effect.ignore);
  return environmentId;
});

/** A cube and the host environment that owns it. */
export interface HostedCube {
  readonly hostEnvironmentId: EnvironmentId;
  readonly cube: CubeSummary;
}

/**
 * The cube serving `environmentId`, from each host's last known list.
 * Null for ordinary environments.
 */
export function findCubeByEnvironment(
  cubesByHost: ReadonlyMap<EnvironmentId, ReadonlyArray<CubeSummary>>,
  environmentId: EnvironmentId,
): HostedCube | null {
  for (const [hostEnvironmentId, cubes] of cubesByHost) {
    const cube = cubes.find((candidate) => candidate.environmentId === environmentId);
    if (cube) return { hostEnvironmentId, cube };
  }
  return null;
}

/** What this client must do so a running cube is reachable. */
export type CubeRegistrationAction =
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

export function cubeRegistrationAction(
  entry: Pick<ConnectionCatalogEntry, "profile" | "target"> | undefined,
  httpBaseUrl: string,
): CubeRegistrationAction {
  if (entry === undefined) return { kind: "register" };
  const savedBaseUrl = Option.match(entry.profile, {
    onNone: () => null,
    onSome: (profile) => ("httpBaseUrl" in profile ? profile.httpBaseUrl : null),
  });
  // Saved profiles keep the trailing slash URL parsing adds; comparing raw
  // strings would reconnect a healthy cube on every sync.
  return savedBaseUrl !== null && !sameOrigin(savedBaseUrl, httpBaseUrl)
    ? { kind: "update", httpBaseUrl, label: entry.target.label }
    : { kind: "none" };
}

const registerCubeEnvironment = Effect.fn("clientRuntime.cube.ensureEnvironment")(function* (
  hostEnvironmentId: EnvironmentId,
  cube: CubeSummary,
  target: { readonly environmentId: EnvironmentId; readonly httpBaseUrl: string },
) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const onboarding = yield* ConnectionOnboarding.ConnectionOnboarding;
  const entry = (yield* SubscriptionRef.get(registry.entries)).get(target.environmentId);
  const action = cubeRegistrationAction(entry, target.httpBaseUrl);
  if (action.kind === "register") {
    const pairing = yield* onHost(hostEnvironmentId, request(WS_METHODS.cubePair, { id: cube.id }));
    return yield* onboarding.registerPairing({
      host: pairing.httpBaseUrl,
      pairingCode: pairing.credential,
      connectWhen: cubeConnectWhen(cube),
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
 * One registration at a time per cube. A launch and a background sync can
 * both find the same new cube; pairing it twice registers it twice, and
 * the second registration replaces the first while it is still connecting.
 */
const registrationLock = PartitionedSemaphore.makeUnsafe<EnvironmentId>({ permits: 1 });

/**
 * Makes one running cube reachable from this client: registers it on first
 * sight, and otherwise refreshes its saved address, since Docker publishes a
 * cube on a new port each time it starts. Returns its environment.
 */
export const ensureCubeEnvironment = (hostEnvironmentId: EnvironmentId, cube: CubeSummary) =>
  cube.httpBaseUrl === null || cube.environmentId === null
    ? Effect.fail(new CubeNotRunningError({ id: cube.id }))
    : registrationLock.withPermit(cube.environmentId)(
        registerCubeEnvironment(hostEnvironmentId, cube, {
          environmentId: cube.environmentId,
          httpBaseUrl: cube.httpBaseUrl,
        }),
      );

/**
 * Fly cubes connect only when needed: a sleeping one wakes when something
 * connects, so a client must not retry it in the background. Docker cubes
 * cannot wake on request and keep an ordinary connection.
 */
export const cubeConnectWhen = (cube: Pick<CubeSummary, "backend">): ConnectWhen =>
  cube.backend === "fly" ? "needed" : "always";

/**
 * How this client's saved connection to a cube should change to match it.
 * A Fly cube stays switched on whatever its state and connects when
 * needed. A Docker cube's connection is switched off while it is stopped,
 * so the client stops retrying it, and back on once it is serving again,
 * whoever woke it.
 */
export function cubeConnectionChange(
  entry: Pick<ConnectionCatalogEntry, "enabled" | "connectWhen"> | undefined,
  cube: Pick<CubeSummary, "backend" | "state" | "httpBaseUrl">,
): { readonly enabled?: boolean; readonly connectWhen?: ConnectWhen } {
  if (entry === undefined) return {};
  if (cubeConnectWhen(cube) === "needed") {
    return {
      ...(entry.connectWhen === "needed" ? {} : { connectWhen: "needed" as const }),
      ...(entry.enabled ? {} : { enabled: true }),
    };
  }
  if (cube.state !== "running") return entry.enabled ? { enabled: false } : {};
  return cube.httpBaseUrl !== null && !entry.enabled ? { enabled: true } : {};
}

/**
 * Brings this client's view of a host's cubes up to date and returns
 * them: serving cubes are registered or re-addressed, connections follow
 * each cube's state, and connections to deleted cubes are forgotten. A cube that fails to register is skipped
 * and retried on the next sync.
 */
export const syncCubeEnvironments = Effect.fn("clientRuntime.cube.syncEnvironments")(function* (
  hostEnvironmentId: EnvironmentId,
) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const cubes = yield* registry.run(hostEnvironmentId, request(WS_METHODS.cubeList, {}));
  // A cube deleted anywhere (another device, the CLI, automatic removal)
  // leaves this client a connection that can never connect again.
  const removed = yield* registry
    .run(hostEnvironmentId, request(WS_METHODS.cubeRemovedEnvironments, {}))
    .pipe(Effect.orElseSucceed((): ReadonlyArray<EnvironmentId> => []));
  const knownBeforeRemoval = yield* SubscriptionRef.get(registry.entries);
  yield* Effect.forEach(
    removed.filter((environmentId) => knownBeforeRemoval.has(environmentId)),
    (environmentId) => registry.remove(environmentId).pipe(Effect.ignore),
    { discard: true },
  );
  const entries = yield* SubscriptionRef.get(registry.entries);
  yield* Effect.forEach(
    cubes,
    (cube) => {
      const environmentId = cube.environmentId;
      if (environmentId === null) return Effect.void;
      const change = cubeConnectionChange(entries.get(environmentId), cube);
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
    cubes.filter((cube) => cube.state === "running" && cube.httpBaseUrl !== null),
    (cube) =>
      ensureCubeEnvironment(hostEnvironmentId, cube).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not register cube environment.").pipe(
            Effect.annotateLogs({ cubeId: cube.id, cause }),
          ),
        ),
      ),
    { discard: true },
  );
  return cubes;
});

export type CubeChange = "start" | "stop" | "remove";

/**
 * Starts, stops, or deletes a cube through its host and returns the host's
 * cubes afterwards. Stopping first closes this client's connection to it
 * (see `cubeConnectionChange`), starting connects at its new address, and
 * deleting forgets it, since its environment is gone.
 */
export const changeCubeEnvironment = Effect.fn("clientRuntime.cube.change")(function* (
  hostEnvironmentId: EnvironmentId,
  cube: CubeSummary,
  change: CubeChange,
) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  switch (change) {
    case "start": {
      const started = yield* onHost(
        hostEnvironmentId,
        request(WS_METHODS.cubeStart, { id: cube.id }),
      );
      if (started.environmentId !== null) {
        yield* registry.setEnabled(started.environmentId, true).pipe(Effect.ignore);
      }
      const environmentId = yield* ensureCubeEnvironment(hostEnvironmentId, started);
      // Starting it is a need: connect now rather than when next used.
      yield* registry.ensureConnected(environmentId, "60 seconds").pipe(Effect.ignore);
      break;
    }
    case "stop":
      if (cubeConnectWhen(cube) === "needed" && cube.environmentId !== null) {
        // A Fly cube puts itself to sleep, refusing while its agent works,
        // and then this client stays disconnected until it is next needed. A
        // cube this client cannot reach is asleep already.
        yield* registry
          .run(cube.environmentId, request(WS_METHODS.cubeSleep, {}))
          .pipe(Effect.catchTag("EnvironmentRpcUnavailableError", () => Effect.void));
        yield* registry.disconnect(cube.environmentId);
        break;
      }
      // A Docker cube is switched off until it is started again.
      if (cube.environmentId !== null) {
        yield* registry.setEnabled(cube.environmentId, false).pipe(Effect.ignore);
      }
      yield* onHost(hostEnvironmentId, request(WS_METHODS.cubeStop, { id: cube.id }));
      break;
    case "remove":
      yield* onHost(hostEnvironmentId, request(WS_METHODS.cubeRemove, { id: cube.id }));
      if (cube.environmentId !== null) {
        yield* registry.remove(cube.environmentId).pipe(Effect.ignore);
      }
      break;
  }
  return yield* onHost(hostEnvironmentId, request(WS_METHODS.cubeList, {}));
});
