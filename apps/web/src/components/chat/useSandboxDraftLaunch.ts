import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useState } from "react";

import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../../logicalProject";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentProjects } from "../../state/projects";
import { connectSandbox, sandboxEnvironment, syncSandboxes } from "../../state/sandbox";
import { useAtomCommand } from "../../state/use-atom-command";
import { waitForAtomValue } from "../../state/waitForAtomValue";

/** The project appears once the sandbox has cloned the repository, which large ones make slow. */
const SANDBOX_PROJECT_TIMEOUT_MS = 300_000;

export type SandboxLaunchStageId = "create" | "connect" | "clone" | "send";

export interface SandboxLaunchStage {
  readonly id: SandboxLaunchStageId;
  readonly status: "pending" | "running" | "done" | "failed";
  readonly startedAt: number | null;
  readonly endedAt: number | null;
}

/** What a draft that is starting in a new sandbox shows instead of its composer. */
export type SandboxLaunchState =
  | { readonly phase: "idle" }
  | {
      readonly phase: "starting" | "failed";
      readonly startedAt: number;
      readonly stages: ReadonlyArray<SandboxLaunchStage>;
      /** Why the launch stopped, in the user's terms. */
      readonly error: string | null;
    };

const STAGE_ORDER: ReadonlyArray<SandboxLaunchStageId> = ["create", "connect", "clone", "send"];

/** Marks `id` running from `now`, finishing every earlier stage. */
export function advanceSandboxLaunch(
  state: SandboxLaunchState,
  id: SandboxLaunchStageId,
  now: number,
): SandboxLaunchState {
  const startedAt = state.phase === "idle" ? now : state.startedAt;
  const previous = state.phase === "idle" ? [] : state.stages;
  const target = STAGE_ORDER.indexOf(id);
  return {
    phase: "starting",
    startedAt,
    error: null,
    stages: STAGE_ORDER.map((stageId, index) => {
      const current = previous.find((stage) => stage.id === stageId);
      if (index < target) {
        return {
          id: stageId,
          status: "done",
          startedAt: current?.startedAt ?? now,
          endedAt: current?.endedAt ?? now,
        };
      }
      if (index === target)
        return { id: stageId, status: "running", startedAt: now, endedAt: null };
      return { id: stageId, status: "pending", startedAt: null, endedAt: null };
    }),
  };
}

/** Fails the running stage with a message, keeping finished stages as they were. */
export function failSandboxLaunch(
  state: SandboxLaunchState,
  error: string,
  now: number,
): SandboxLaunchState {
  if (state.phase === "idle") return state;
  return {
    ...state,
    phase: "failed",
    error,
    stages: state.stages.map((stage) =>
      stage.status === "running" ? { ...stage, status: "failed", endedAt: now } : stage,
    ),
  };
}

const failureMessage = (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error && failure.message.trim().length > 0
    ? failure.message
    : "The sandbox could not be created.";
};

/**
 * Creates a sandbox for a draft, connects to it, and resolves the project the
 * draft should move to: the sandbox's copy of the same logical project, which
 * appears once the sandbox has cloned it. The caller sends the queued message
 * there, then calls `finish`.
 */
export function useSandboxDraftLaunch() {
  const create = useAtomCommand(sandboxEnvironment.create, { reportFailure: false });
  const connect = useAtomCommand(connectSandbox, { reportFailure: false });
  const sync = useAtomCommand(syncSandboxes, { reportFailure: false });
  const [state, setState] = useState<SandboxLaunchState>({ phase: "idle" });

  const launch = async (input: {
    readonly hostEnvironmentId: EnvironmentId;
    readonly repositoryUrl: string;
    readonly logicalProjectKey: string;
    readonly projectGroupingSettings: ReturnType<typeof selectProjectGroupingSettings>;
  }): Promise<{ environmentId: EnvironmentId; projectId: ProjectId } | null> => {
    setState(advanceSandboxLaunch({ phase: "idle" }, "create", Date.now()));
    const fail = (error: string) => {
      setState((current) => failSandboxLaunch(current, error, Date.now()));
      return null;
    };

    const created = await create({
      environmentId: input.hostEnvironmentId,
      input: { repositoryUrl: input.repositoryUrl },
    });
    if (created._tag === "Failure") {
      if (isAtomCommandInterrupted(created)) return fail("Starting the sandbox was interrupted.");
      return fail(failureMessage(created));
    }

    setState((current) => advanceSandboxLaunch(current, "connect", Date.now()));
    const connected = await connect({
      hostEnvironmentId: input.hostEnvironmentId,
      sandbox: created.value,
    });
    if (connected._tag === "Failure") return fail(failureMessage(connected));
    const environmentId = connected.value;
    // Thread menus find the new sandbox through the host's list.
    void sync(input.hostEnvironmentId);
    setState((current) => advanceSandboxLaunch(current, "clone", Date.now()));
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
      return fail("The sandbox is running, but the repository did not finish cloning in it.");
    }
    setState((current) => advanceSandboxLaunch(current, "send", Date.now()));
    return { environmentId, projectId: project.id };
  };

  return {
    state,
    launching: state.phase === "starting",
    launch,
    /** Clears the launch once its message was sent, or to return to the draft. */
    finish: () => setState({ phase: "idle" }),
  };
}
