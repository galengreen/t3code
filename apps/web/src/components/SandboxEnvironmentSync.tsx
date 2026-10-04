import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo } from "react";

import { environmentServerConfigsAtom } from "../state/server";
import { syncSandboxes } from "../state/sandbox";
import { useAtomCommand } from "../state/use-atom-command";

/** Sandboxes start, stop, and appear from other devices, so their lists are refreshed this often. */
const REFRESH_INTERVAL_MS = 60_000;

/**
 * Keeps every connected host's running sandboxes registered in this client, so
 * a sandbox created from any device shows up here without pairing by hand, and
 * keeps their states current for thread menus. Runs when the set of
 * sandbox-enabled hosts changes, then once a minute while the window is shown.
 */
export function SandboxEnvironmentSync() {
  const configs = useAtomValue(environmentServerConfigsAtom);
  const sync = useAtomCommand(syncSandboxes, { reportFailure: false });
  const hostKey = useMemo(
    () =>
      [...configs]
        .filter(([, config]) => config.settings.enableSandboxes)
        .map(([environmentId]) => environmentId)
        .toSorted()
        .join(","),
    [configs],
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
