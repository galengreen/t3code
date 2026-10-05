import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo } from "react";

import { useEnvironments } from "../state/environments";
import { syncCubes } from "../state/cube";
import { useAtomCommand } from "../state/use-atom-command";

/** Cubes start, stop, and appear from other devices, so their lists are refreshed this often. */
const REFRESH_INTERVAL_MS = 60_000;

/**
 * Keeps every connected host's running cubes registered in this client, so
 * a cube created from any device shows up here without pairing by hand, and
 * keeps their states current for thread menus. Runs when a cube-enabled
 * host connects, then once a minute while the window is shown.
 */
export function CubeEnvironmentSync() {
  const { environments } = useEnvironments();
  const sync = useAtomCommand(syncCubes, { reportFailure: false });
  // Cached configs are known before the socket connects, and a request then
  // fails, so a host only counts once it is connected.
  const hostKey = useMemo(
    () =>
      environments
        .filter(
          (environment) =>
            environment.connection.phase === "connected" &&
            environment.serverConfig?.settings.enableCubes === true,
        )
        .map((environment) => environment.environmentId)
        .toSorted()
        .join(","),
    [environments],
  );
  useEffect(() => {
    if (hostKey === "") return;
    const syncAll = () => {
      for (const hostEnvironmentId of hostKey.split(",")) {
        void sync(hostEnvironmentId as EnvironmentId);
      }
    };
    syncAll();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") syncAll();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [hostKey, sync]);
  return null;
}
