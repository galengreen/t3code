import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo } from "react";

import { environmentServerConfigsAtom } from "../state/server";
import { syncSandboxes } from "../state/sandbox";
import { useAtomCommand } from "../state/use-atom-command";

/**
 * Keeps every connected host's running sandboxes registered in this client, so
 * a sandbox created from any device shows up here without pairing by hand.
 * Runs when the set of sandbox-enabled hosts changes.
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
    for (const hostEnvironmentId of hostKey.split(",")) {
      void sync(hostEnvironmentId as EnvironmentId);
    }
  }, [hostKey, sync]);
  return null;
}
