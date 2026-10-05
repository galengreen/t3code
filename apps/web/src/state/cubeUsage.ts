/**
 * Cube running time and cost from every connected environment that hosts
 * cubes, for the usage page.
 *
 * @module state/cubeUsage
 */
import { useAtomValue } from "@effect/atom-react";
import type { CubeUsage, CubeUsageInput, EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { cubeEnvironment } from "./cube";
import { environmentPresentations } from "./presentation";

export interface HostCubeUsageStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly usage: CubeUsage | null;
  /** The Fly organization new cubes go to, for linking to its bill. */
  readonly flyOrganization: string | null;
}

/** Environments with cubes turned on; a cube's own server never hosts any. */
const cubeHostsAtom = Atom.make((get) =>
  [...get(environmentPresentations.presentationsAtom)].flatMap(([environmentId, presentation]) => {
    const settings = presentation.serverConfig?.settings;
    return settings?.enableCubes
      ? [
          {
            environmentId,
            label: presentation.entry.target.label,
            flyOrganization: settings.cubeFly.organization || null,
          },
        ]
      : [];
  }),
).pipe(Atom.withLabel("web-cube-usage:hosts"));

const cubeUsageByWindowAtom = Atom.family((windowKey: string) =>
  Atom.make((get): readonly HostCubeUsageStatus[] => {
    const input = JSON.parse(windowKey) as CubeUsageInput;
    return get(cubeHostsAtom).map((host) => {
      const result = get(cubeEnvironment.usage({ environmentId: host.environmentId, input }));
      return {
        ...host,
        isPending: result.waiting,
        error: result._tag === "Failure" ? "This environment could not report cube usage." : null,
        usage: Option.getOrNull(AsyncResult.value(result)),
      };
    });
  }).pipe(Atom.withLabel(`web-cube-usage:window:${windowKey}`)),
);

/** Whether any connected environment hosts cubes, so the page offers the view. */
export function useHasCubeHosts(): boolean {
  return useAtomValue(cubeHostsAtom).length > 0;
}

export function useCubeUsage(
  input: CubeUsageInput,
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null,
) {
  const windowKey = JSON.stringify({ sinceTime: input.sinceTime, untilTime: input.untilTime });
  const hosts = useAtomValue(cubeUsageByWindowAtom(windowKey));
  const selected = useMemo(
    () =>
      selectedEnvironmentIds === null
        ? hosts
        : hosts.filter((host) => selectedEnvironmentIds.has(host.environmentId)),
    [hosts, selectedEnvironmentIds],
  );
  return {
    hosts: selected,
    isPending:
      selected.length > 0 && selected.every((host) => host.usage === null && host.error === null),
  };
}

/** Asks every selected cube host again, for the page's refresh button. */
export function refreshCubeUsage(
  input: CubeUsageInput,
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null,
) {
  for (const host of appAtomRegistry.get(cubeHostsAtom)) {
    if (selectedEnvironmentIds !== null && !selectedEnvironmentIds.has(host.environmentId))
      continue;
    appAtomRegistry.refresh(cubeEnvironment.usage({ environmentId: host.environmentId, input }));
  }
}
