import {
  changeSandboxEnvironment,
  createSandboxEnvironmentAtoms,
  ensureSandboxEnvironment,
  findSandboxByEnvironment,
  type SandboxChange,
  syncSandboxEnvironments,
} from "@t3tools/client-runtime/state/sandbox";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, SandboxSummary } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import { Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

export const sandboxEnvironment = createSandboxEnvironmentAtoms(connectionAtomRuntime);

const sandboxScheduler = createAtomCommandScheduler();

/** Each sandbox host's sandboxes, as of its last sync or change. */
const hostSandboxesAtom = Atom.make<ReadonlyMap<EnvironmentId, ReadonlyArray<SandboxSummary>>>(
  new Map(),
).pipe(Atom.keepAlive, Atom.withLabel("web:sandbox:host-sandboxes"));

const recordHostSandboxes = (
  hostEnvironmentId: EnvironmentId,
  sandboxes: ReadonlyArray<SandboxSummary>,
) =>
  Effect.sync(() => {
    const next = new Map(appAtomRegistry.get(hostSandboxesAtom));
    next.set(hostEnvironmentId, sandboxes);
    appAtomRegistry.set(hostSandboxesAtom, next);
  });

/** Changes in flight per sandbox id, so every surface can show a sandbox waking or stopping. */
const pendingSandboxChangesAtom = Atom.make<ReadonlyMap<string, SandboxChange>>(new Map()).pipe(
  Atom.keepAlive,
  Atom.withLabel("web:sandbox:pending-changes"),
);

const setPendingSandboxChange = (sandboxId: string, change: SandboxChange | null) =>
  Effect.sync(() => {
    const next = new Map(appAtomRegistry.get(pendingSandboxChangesAtom));
    if (change === null) next.delete(sandboxId);
    else next.set(sandboxId, change);
    appAtomRegistry.set(pendingSandboxChangesAtom, next);
  });

/** The change in flight for a sandbox, if any. */
export function usePendingSandboxChange(sandboxId: string | null): SandboxChange | null {
  const pending = useAtomValue(pendingSandboxChangesAtom);
  return sandboxId === null ? null : (pending.get(sandboxId) ?? null);
}

/** The sandbox serving an environment, for thread menus read at open time. */
export function readSandboxForEnvironment(environmentId: EnvironmentId) {
  return findSandboxByEnvironment(appAtomRegistry.get(hostSandboxesAtom), environmentId);
}

/** The sandbox serving an environment; null for ordinary environments. */
export function useSandboxForEnvironment(environmentId: EnvironmentId | null) {
  const sandboxesByHost = useAtomValue(hostSandboxesAtom);
  return useMemo(
    () =>
      environmentId === null ? null : findSandboxByEnvironment(sandboxesByHost, environmentId),
    [environmentId, sandboxesByHost],
  );
}

/** Environments that are sandboxes, which pickers list under their thread instead. */
export function useSandboxEnvironmentIds(): ReadonlySet<EnvironmentId> {
  const sandboxesByHost = useAtomValue(hostSandboxesAtom);
  return useMemo(
    () =>
      new Set(
        [...sandboxesByHost.values()].flatMap((sandboxes) =>
          sandboxes.flatMap((sandbox) => (sandbox.environmentId ? [sandbox.environmentId] : [])),
        ),
      ),
    [sandboxesByHost],
  );
}

/** Starts, stops, or deletes a sandbox and records its host's list afterwards. */
export const changeSandbox = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:sandbox:change",
  scheduler: sandboxScheduler,
  concurrency: {
    mode: "singleFlight",
    key: (input: { readonly sandbox: SandboxSummary }) => input.sandbox.id,
  },
  execute: (input: {
    readonly hostEnvironmentId: EnvironmentId;
    readonly sandbox: SandboxSummary;
    readonly change: SandboxChange;
  }) =>
    setPendingSandboxChange(input.sandbox.id, input.change).pipe(
      Effect.andThen(
        changeSandboxEnvironment(input.hostEnvironmentId, input.sandbox, input.change),
      ),
      Effect.tap((sandboxes) => recordHostSandboxes(input.hostEnvironmentId, sandboxes)),
      Effect.ensuring(setPendingSandboxChange(input.sandbox.id, null)),
    ),
});

/** Registers a host's running sandboxes and refreshes their addresses. */
export const syncSandboxes = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:sandbox:sync",
  scheduler: sandboxScheduler,
  concurrency: {
    mode: "singleFlight",
    key: (hostEnvironmentId: EnvironmentId) => hostEnvironmentId,
  },
  execute: (hostEnvironmentId: EnvironmentId) =>
    syncSandboxEnvironments(hostEnvironmentId).pipe(
      Effect.tap((sandboxes) => recordHostSandboxes(hostEnvironmentId, sandboxes)),
    ),
});

/** Pairs with a running sandbox and registers it, returning its environment. */
export const connectSandbox = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:sandbox:connect",
  execute: (input: {
    readonly hostEnvironmentId: EnvironmentId;
    readonly sandbox: SandboxSummary;
  }) => ensureSandboxEnvironment(input.hostEnvironmentId, input.sandbox),
});
