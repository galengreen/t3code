import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useState } from "react";

import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../../logicalProject";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentProjects } from "../../state/projects";
import { launchSandbox } from "../../state/sandbox";
import { useAtomCommand } from "../../state/use-atom-command";
import { waitForAtomValue } from "../../state/waitForAtomValue";
import { toastManager } from "../ui/toast";

/** A sandbox clones the repository and boots its server before its project appears. */
const SANDBOX_PROJECT_TIMEOUT_MS = 120_000;
const SANDBOX_LABEL_LENGTH = 48;

/** A short sandbox name from the first line of the prompt. */
export function sandboxLabelFromPrompt(prompt: string): string | undefined {
  const firstLine = prompt
    .split("\n")
    .find((line) => line.trim().length > 0)
    ?.trim();
  if (!firstLine) return undefined;
  return firstLine.length > SANDBOX_LABEL_LENGTH
    ? `${firstLine.slice(0, SANDBOX_LABEL_LENGTH - 1).trimEnd()}…`
    : firstLine;
}

/**
 * Creates a sandbox for a draft and resolves the project the draft should move
 * to: the sandbox's copy of the same logical project. Reports failures itself
 * and resolves null, so the caller only acts on success.
 */
export function useSandboxDraftLaunch() {
  const launch = useAtomCommand(launchSandbox, { reportFailure: false });
  const [launching, setLaunching] = useState(false);

  const launchForProject = async (input: {
    readonly hostEnvironmentId: EnvironmentId;
    readonly repositoryUrl: string;
    readonly label: string | undefined;
    readonly logicalProjectKey: string;
    readonly projectGroupingSettings: ReturnType<typeof selectProjectGroupingSettings>;
  }): Promise<{ environmentId: EnvironmentId; projectId: ProjectId } | null> => {
    setLaunching(true);
    try {
      const result = await launch({
        hostEnvironmentId: input.hostEnvironmentId,
        sandbox: {
          repositoryUrl: input.repositoryUrl,
          ...(input.label ? { label: input.label } : {}),
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          toastManager.add({
            type: "error",
            title: "Could not create sandbox",
            description: "Check that sandboxes are set up on this machine, then try again.",
          });
        }
        return null;
      }
      const environmentId = result.value;
      const matches = (project: { environmentId: EnvironmentId }) =>
        project.environmentId === environmentId &&
        deriveLogicalProjectKeyFromSettings(
          project as Parameters<typeof deriveLogicalProjectKeyFromSettings>[0],
          input.projectGroupingSettings,
        ) === input.logicalProjectKey;
      const found = await waitForAtomValue({
        registry: appAtomRegistry,
        atom: environmentProjects.projectsAtom,
        predicate: (projects) => projects.some(matches),
        timeoutMs: SANDBOX_PROJECT_TIMEOUT_MS,
      });
      const project = appAtomRegistry.get(environmentProjects.projectsAtom).find(matches);
      if (!found || !project) {
        toastManager.add({
          type: "error",
          title: "Sandbox started without this project",
          description: "The sandbox is running, but the repository did not appear in it.",
        });
        return null;
      }
      return { environmentId, projectId: project.id };
    } finally {
      setLaunching(false);
    }
  };

  return { launching, launch: launchForProject };
}
