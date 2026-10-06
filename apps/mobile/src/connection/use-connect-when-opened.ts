import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { useRemoteConnectionStatus } from "../state/use-remote-environment-registry";
import { useAtomCommand } from "../state/use-atom-command";
import { environmentCatalog } from "./catalog";

/**
 * Opening a thread is a need: connects its environment if it connects only
 * when needed (a sleeping cube), waking it. Once per opening, so a cube
 * that goes to sleep while the thread is open stays asleep until the user
 * sends something.
 */
export function useConnectWhenOpened(environmentId: EnvironmentId | null): void {
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const connect = useAtomCommand(environmentCatalog.connect, { reportFailure: false });
  const environment = connectedEnvironments.find(
    (candidate) => candidate.environmentId === environmentId,
  );
  const openedRef = useRef<EnvironmentId | null>(null);
  useEffect(() => {
    if (environmentId === null || environment === undefined) return;
    if (openedRef.current === environmentId) return;
    openedRef.current = environmentId;
    if (
      environment.connectsWhenNeeded &&
      environment.isEnabled &&
      environment.connectionState === "available"
    ) {
      void connect(environmentId);
    }
  }, [connect, environment, environmentId]);
}
