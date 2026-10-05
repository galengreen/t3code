import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { CheckIcon, CircleIcon, LaptopIcon, PencilIcon, RotateCwIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import type { CubeLaunchStage, CubeLaunchStageId, CubeLaunchState } from "./useCubeDraftLaunch";
import { WorkLogRow } from "./WorkLog";

/** Ticks once a second while the launch runs, for the elapsed labels. */
function useNowWhile(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [active]);
  return nowMs;
}

function stageLabel(id: CubeLaunchStageId, repositoryName: string | null): string {
  switch (id) {
    case "create":
      return "Start cube";
    case "connect":
      return "Connect";
    case "clone":
      return repositoryName ? `Clone ${repositoryName}` : "Clone repository";
    case "send":
      return "Send message";
  }
}

function StageIcon({ status }: { status: CubeLaunchStage["status"] }) {
  const className = "size-4 shrink-0 stroke-2";
  switch (status) {
    case "done":
      return <CheckIcon aria-hidden className={className} />;
    case "running":
      return <Spinner size="md" className="shrink-0" />;
    case "failed":
      return <XIcon aria-hidden className={className} />;
    case "pending":
      return <CircleIcon aria-hidden className={className} />;
  }
}

/**
 * Stands in for the composer while a draft's first message waits for its new
 * cube: the message as it will be sent, then each setup stage with its
 * time. A failed launch keeps the message and offers to retry, run it on
 * this machine instead, or go back to editing it.
 */
export function CubeLaunchCard({
  state,
  prompt,
  repositoryName,
  onRetry,
  onRunHere,
  onEdit,
}: {
  readonly state: Exclude<CubeLaunchState, { phase: "idle" }>;
  readonly prompt: string;
  readonly repositoryName: string | null;
  readonly onRetry: () => void;
  readonly onRunHere: () => void;
  readonly onEdit: () => void;
}) {
  const running = state.phase === "starting";
  const nowMs = useNowWhile(running);
  const lastEnd = Math.max(...state.stages.map((stage) => stage.endedAt ?? 0));
  const totalElapsed = Math.max(0, (running ? nowMs : lastEnd) - state.startedAt);

  return (
    <section
      aria-label="Cube setup"
      data-cube-launch-phase={state.phase}
      className="flex flex-col gap-4"
    >
      <div className="flex flex-col items-end gap-1">
        <div className="max-w-[80%] rounded-2xl bg-message p-3 text-message-foreground">
          <p className="line-clamp-6 text-sm whitespace-pre-wrap">{prompt}</p>
        </div>
        <span className="me-1 text-2xs text-muted-foreground/70">
          {running ? "Sends when the cube is ready" : "Not sent"}
        </span>
      </div>

      <div>
        <div className="border-b border-border/60 pb-2 pt-1">
          <div
            className={cn(
              "flex h-6 min-w-0 items-baseline gap-2 px-1 text-sm leading-relaxed tabular-nums",
              running ? "text-muted-foreground" : "text-destructive-foreground",
            )}
          >
            <span className="truncate">{running ? "Setting up cube…" : "Cube setup failed"}</span>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
              {formatDuration(totalElapsed)}
            </span>
          </div>
        </div>
        <div className="pt-1.5">
          {state.stages.map((stage) => {
            const elapsed =
              stage.startedAt === null
                ? null
                : Math.max(0, (stage.endedAt ?? nowMs) - stage.startedAt);
            return (
              <WorkLogRow
                key={stage.id}
                data-cube-launch-stage={stage.id}
                data-cube-launch-status={stage.status}
                icon={
                  <span
                    className={cn("text-icon-muted", stage.status === "pending" && "opacity-40")}
                  >
                    <StageIcon status={stage.status} />
                  </span>
                }
                label={
                  <span
                    className={cn(
                      "block truncate",
                      stage.status === "failed"
                        ? "text-destructive-foreground"
                        : stage.status === "pending"
                          ? "text-secondary-label opacity-40"
                          : "text-secondary-label",
                    )}
                  >
                    {stageLabel(stage.id, repositoryName)}
                  </span>
                }
                trailing={
                  elapsed !== null ? (
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {formatDuration(elapsed)}
                    </span>
                  ) : null
                }
              />
            );
          })}
        </div>
        {state.error ? (
          <p className="mt-1 ml-8 text-xs text-muted-foreground">{state.error}</p>
        ) : null}
        {running ? null : (
          <div className="mt-1 ml-[calc(--spacing(6)+2px-(--spacing(2)-1px))] flex flex-wrap items-center gap-0.5">
            <Button type="button" size="xs" variant="ghost-muted" onClick={onRetry}>
              <RotateCwIcon aria-hidden />
              Try again
            </Button>
            <Button type="button" size="xs" variant="ghost-muted" onClick={onRunHere}>
              <LaptopIcon aria-hidden />
              Run on this machine
            </Button>
            <Button type="button" size="xs" variant="ghost-muted" onClick={onEdit}>
              <PencilIcon aria-hidden />
              Edit message
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
