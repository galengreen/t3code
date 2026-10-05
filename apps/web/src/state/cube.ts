import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import {
  changeCubeEnvironment,
  createCubeEnvironmentAtoms,
  ensureCubeEnvironment,
  findCubeByEnvironment,
  type CubeChange,
  syncCubeEnvironments,
} from "@t3tools/client-runtime/state/cube";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, CubeSummary } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import { Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

export const cubeEnvironment = createCubeEnvironmentAtoms(connectionAtomRuntime);

const cubeScheduler = createAtomCommandScheduler();

/** Each cube host's cubes, as of its last sync or change. */
const hostCubesAtom = Atom.make<ReadonlyMap<EnvironmentId, ReadonlyArray<CubeSummary>>>(
  new Map(),
).pipe(Atom.keepAlive, Atom.withLabel("web:cube:host-cubes"));

const recordHostCubes = (hostEnvironmentId: EnvironmentId, cubes: ReadonlyArray<CubeSummary>) =>
  Effect.sync(() => {
    const next = new Map(appAtomRegistry.get(hostCubesAtom));
    next.set(hostEnvironmentId, cubes);
    appAtomRegistry.set(hostCubesAtom, next);
  });

/** Changes in flight per cube id, so every surface can show a cube waking or stopping. */
const pendingCubeChangesAtom = Atom.make<ReadonlyMap<string, CubeChange>>(new Map()).pipe(
  Atom.keepAlive,
  Atom.withLabel("web:cube:pending-changes"),
);

const setPendingCubeChange = (cubeId: string, change: CubeChange | null) =>
  Effect.sync(() => {
    const next = new Map(appAtomRegistry.get(pendingCubeChangesAtom));
    if (change === null) next.delete(cubeId);
    else next.set(cubeId, change);
    appAtomRegistry.set(pendingCubeChangesAtom, next);
  });

/** The change in flight for a cube, if any. */
export function usePendingCubeChange(cubeId: string | null): CubeChange | null {
  const pending = useAtomValue(pendingCubeChangesAtom);
  return cubeId === null ? null : (pending.get(cubeId) ?? null);
}

/** The cube serving an environment, for thread menus read at open time. */
export function readCubeForEnvironment(environmentId: EnvironmentId) {
  return findCubeByEnvironment(appAtomRegistry.get(hostCubesAtom), environmentId);
}

/** The cube serving an environment; null for ordinary environments. */
export function useCubeForEnvironment(environmentId: EnvironmentId | null) {
  const cubesByHost = useAtomValue(hostCubesAtom);
  return useMemo(
    () => (environmentId === null ? null : findCubeByEnvironment(cubesByHost, environmentId)),
    [environmentId, cubesByHost],
  );
}

/** Environments that are cubes, which pickers list under their thread instead. */
export function useCubeEnvironmentIds(): ReadonlySet<EnvironmentId> {
  const cubesByHost = useAtomValue(hostCubesAtom);
  return useMemo(
    () =>
      new Set(
        [...cubesByHost.values()].flatMap((cubes) =>
          cubes.flatMap((cube) => (cube.environmentId ? [cube.environmentId] : [])),
        ),
      ),
    [cubesByHost],
  );
}

/** Starts, stops, or deletes a cube and records its host's list afterwards. */
export const changeCube = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:cube:change",
  scheduler: cubeScheduler,
  concurrency: {
    mode: "singleFlight",
    key: (input: { readonly cube: CubeSummary }) => input.cube.id,
  },
  execute: (input: {
    readonly hostEnvironmentId: EnvironmentId;
    readonly cube: CubeSummary;
    readonly change: CubeChange;
  }) =>
    setPendingCubeChange(input.cube.id, input.change).pipe(
      Effect.andThen(changeCubeEnvironment(input.hostEnvironmentId, input.cube, input.change)),
      Effect.tap((cubes) => recordHostCubes(input.hostEnvironmentId, cubes)),
      Effect.ensuring(setPendingCubeChange(input.cube.id, null)),
    ),
});

/** Registers a host's running cubes and refreshes their addresses. */
export const syncCubes = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:cube:sync",
  scheduler: cubeScheduler,
  concurrency: {
    mode: "singleFlight",
    key: (hostEnvironmentId: EnvironmentId) => hostEnvironmentId,
  },
  execute: (hostEnvironmentId: EnvironmentId) =>
    syncCubeEnvironments(hostEnvironmentId).pipe(
      Effect.tap((cubes) => recordHostCubes(hostEnvironmentId, cubes)),
    ),
});

/** Pairs with a running cube and registers it, returning its environment. */
export const connectCube = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:cube:connect",
  execute: (input: { readonly hostEnvironmentId: EnvironmentId; readonly cube: CubeSummary }) =>
    ensureCubeEnvironment(input.hostEnvironmentId, input.cube).pipe(
      // A cube that connects only when needed is not connected by
      // registering it; the launch needs it now.
      Effect.tap((environmentId) =>
        EnvironmentRegistry.EnvironmentRegistry.pipe(
          Effect.flatMap((registry) => registry.ensureConnected(environmentId, "60 seconds")),
        ),
      ),
    ),
});
