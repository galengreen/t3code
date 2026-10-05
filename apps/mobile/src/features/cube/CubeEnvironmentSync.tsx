import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo } from "react";
import { AppState } from "react-native";

import { useServerConfigs } from "../../state/entities";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { syncCubes } from "../../state/cube";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * Keeps every connected host's cubes registered on this phone, so a
 * cube created from any device shows up here without pairing by hand.
 * Runs when a cube host connects and each time the app comes to the
 * foreground. Registering does not keep cubes awake: they connect only
 * when a thread in them is opened or sent to.
 */
export function CubeEnvironmentSync() {
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const serverConfigs = useServerConfigs();
  const sync = useAtomCommand(syncCubes, { reportFailure: false });
  // Cached configs are known before the socket connects, and a request then
  // fails, so a host only counts once it is connected.
  const hostKey = useMemo(
    () =>
      connectedEnvironments
        .filter(
          (environment) =>
            environment.connectionState === "connected" &&
            serverConfigs.get(environment.environmentId)?.settings.enableCubes === true,
        )
        .map((environment) => environment.environmentId)
        .toSorted()
        .join(","),
    [connectedEnvironments, serverConfigs],
  );
  useEffect(() => {
    if (hostKey === "") return;
    const syncAll = () => {
      for (const hostEnvironmentId of hostKey.split(",")) {
        void sync(hostEnvironmentId as EnvironmentId);
      }
    };
    syncAll();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") syncAll();
    });
    return () => subscription.remove();
  }, [hostKey, sync]);
  return null;
}
