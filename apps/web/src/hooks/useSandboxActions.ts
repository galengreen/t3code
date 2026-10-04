import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { readLocalApi } from "../localApi";
import { changeSandbox, readSandboxForEnvironment } from "../state/sandbox";
import { useAtomCommand } from "../state/use-atom-command";

export type SandboxMenuAction = "sandbox:start" | "sandbox:stop" | "sandbox:delete";

const FAILURE_TITLES: Record<SandboxMenuAction, string> = {
  "sandbox:start": "Could not start sandbox",
  "sandbox:stop": "Could not stop sandbox",
  "sandbox:delete": "Could not delete sandbox",
};

/** Whether a thread menu should offer sandbox actions, read when the menu opens. */
export function readThreadSandboxMenuState(environmentId: EnvironmentId) {
  const hosted = readSandboxForEnvironment(environmentId);
  return hosted ? { state: hosted.sandbox.state } : null;
}

/**
 * Runs a thread menu's sandbox action against the sandbox serving the
 * thread's environment. Deleting asks first, since the sandbox's files,
 * including anything not pushed, go with it.
 */
export function useSandboxActions() {
  const change = useAtomCommand(changeSandbox, { reportFailure: false });
  return useCallback(
    async (environmentId: EnvironmentId, action: SandboxMenuAction) => {
      const hosted = readSandboxForEnvironment(environmentId);
      if (!hosted) return;
      if (action === "sandbox:delete") {
        const api = readLocalApi();
        if (!api) return;
        const confirmed = await settlePromise(() =>
          api.dialogs.confirm(
            [
              `Delete sandbox "${hosted.sandbox.label}"?`,
              "Its files go with it, including changes that were not pushed. The thread's conversation stays but can no longer run.",
            ].join("\n"),
            { variant: "destructive" },
          ),
        );
        if (confirmed._tag === "Failure" || !confirmed.value) return;
      }
      const result = await change({
        hostEnvironmentId: hosted.hostEnvironmentId,
        sandbox: hosted.sandbox,
        change:
          action === "sandbox:start" ? "start" : action === "sandbox:stop" ? "stop" : "remove",
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: FAILURE_TITLES[action],
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
    [change],
  );
}
