import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo } from "react";

import { environmentCatalog } from "../connection/catalog";
import { useEnvironments } from "../state/environments";
import { keepCubeHosts, syncCubes } from "../state/cube";
import { useAtomCommand } from "../state/use-atom-command";

/** Cubes start, stop, and appear from other devices, so their lists are refreshed this often. */
const REFRESH_INTERVAL_MS = 60_000;

const splitKey = (key: string) => (key === "" ? [] : (key.split(",") as EnvironmentId[]));

/**
 * Keeps every connected host's running cubes registered in this client, so
 * a cube created from any device shows up here without pairing by hand, and
 * keeps their states current for thread menus. Runs when a cube-enabled
 * host connects, then once a minute while the window is shown.
 *
 * A host that sleeps until needed (a cube home) is woken when the app opens
 * and whenever it is brought back, not when it falls asleep while the app
 * sits in the background, which would keep it awake for nothing.
 */
export function CubeEnvironmentSync() {
  const { environments } = useEnvironments();
  const sync = useAtomCommand(syncCubes, { reportFailure: false });
  const connect = useAtomCommand(environmentCatalog.connect, { reportFailure: false });
  // Hosts as last known, from cached configs too.
  const knownHostKey = useMemo(
    () =>
      environments
        .filter(
          (environment) =>
            environment.entry.enabled && environment.serverConfig?.settings.enableCubes === true,
        )
        .map((environment) => environment.environmentId)
        .toSorted()
        .join(","),
    [environments],
  );
  const sleepingHostKey = useMemo(
    () =>
      environments
        .filter(
          (environment) =>
            environment.entry.connectWhen === "needed" &&
            knownHostKey.split(",").includes(environment.environmentId),
        )
        .map((environment) => environment.environmentId)
        .join(","),
    [environments, knownHostKey],
  );
  // Cached configs are known before the socket connects, and a request then
  // fails, so a host is only synced once it is connected.
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
    keepCubeHosts(new Set(splitKey(knownHostKey)));
  }, [knownHostKey]);
  useEffect(() => {
    const hosts = splitKey(sleepingHostKey);
    if (hosts.length === 0) return;
    const wake = () => {
      if (document.visibilityState !== "visible") return;
      for (const hostEnvironmentId of hosts) void connect(hostEnvironmentId);
    };
    wake();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
    };
  }, [sleepingHostKey, connect]);
  useEffect(() => {
    if (hostKey === "") return;
    const syncAll = () => {
      for (const hostEnvironmentId of splitKey(hostKey)) void sync(hostEnvironmentId);
    };
    syncAll();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") syncAll();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [hostKey, sync]);
  return null;
}
