import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { readLocalApi } from "../localApi";
import { changeSandbox, readSandboxForEnvironment } from "../state/sandbox";
import { useAtomCommand } from "../state/use-atom-command";

export type SandboxMenuAction = "sandbox:start" | "sandbox:stop" | "sandbox:delete";

const FAILURE_TITLES: Record<SandboxMenuAction, string> = {
  "sandbox:start": "Could not start cube",
  "sandbox:stop": "Could not put cube to sleep",
  "sandbox:delete": "Could not delete cube",
};

/** Whether a thread menu should offer sandbox actions, read when the menu opens. */
export function readThreadSandboxMenuState(environmentId: EnvironmentId) {
  const hosted = readSandboxForEnvironment(environmentId);
  return hosted
    ? { state: hosted.sandbox.state, wakesOnRequest: hosted.sandbox.backend === "fly" }
    : null;
}

/**
 * Runs a thread menu's sandbox action against the sandbox serving the
 * thread's environment. Deleting asks first, since the sandbox holds its
 * threads' conversations and files, and leaves any of its threads on screen.
 */
export function useSandboxActions() {
  const change = useAtomCommand(changeSandbox, { reportFailure: false });
  const router = useRouter();
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
              `Delete cube "${hosted.sandbox.label}"?`,
              "Its threads and files go with it, including changes that were not pushed.",
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
      if (
        result._tag === "Success" &&
        action === "sandbox:delete" &&
        router.state.location.pathname.startsWith(`/${environmentId}/`)
      ) {
        void router.navigate({ to: "/" });
      }
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
    [change, router],
  );
}
