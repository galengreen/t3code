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
import { changeCube, readCubeForEnvironment } from "../state/cube";
import { useAtomCommand } from "../state/use-atom-command";

export type CubeMenuAction = "cube:start" | "cube:stop" | "cube:delete";

const FAILURE_TITLES: Record<CubeMenuAction, string> = {
  "cube:start": "Could not start cube",
  "cube:stop": "Could not put cube to sleep",
  "cube:delete": "Could not delete cube",
};

/** Whether a thread menu should offer cube actions, read when the menu opens. */
export function readThreadCubeMenuState(environmentId: EnvironmentId) {
  const hosted = readCubeForEnvironment(environmentId);
  return hosted
    ? { state: hosted.cube.state, wakesOnRequest: hosted.cube.backend === "fly" }
    : null;
}

/**
 * Runs a thread menu's cube action against the cube serving the
 * thread's environment. Deleting asks first, since the cube holds its
 * threads' conversations and files, and leaves any of its threads on screen.
 */
export function useCubeActions() {
  const change = useAtomCommand(changeCube, { reportFailure: false });
  const router = useRouter();
  return useCallback(
    async (environmentId: EnvironmentId, action: CubeMenuAction) => {
      const hosted = readCubeForEnvironment(environmentId);
      if (!hosted) return;
      if (action === "cube:delete") {
        const api = readLocalApi();
        if (!api) return;
        const confirmed = await settlePromise(() =>
          api.dialogs.confirm(
            [
              `Delete cube "${hosted.cube.label}"?`,
              "Its threads and files go with it, including changes that were not pushed.",
            ].join("\n"),
            { variant: "destructive" },
          ),
        );
        if (confirmed._tag === "Failure" || !confirmed.value) return;
      }
      const result = await change({
        hostEnvironmentId: hosted.hostEnvironmentId,
        cube: hosted.cube,
        change: action === "cube:start" ? "start" : action === "cube:stop" ? "stop" : "remove",
      });
      if (
        result._tag === "Success" &&
        action === "cube:delete" &&
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
