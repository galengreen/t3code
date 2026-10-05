import type { EnvironmentId, UsageSummaryInput } from "@t3tools/contracts";
import {
  formatDateTimeShort,
  formatDayShort,
  formatHourShort,
  formatPercent,
  formatUsd,
} from "@t3tools/shared/usageFormat";
import { ArrowUpRightIcon, InfoIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useCubeUsage } from "../../state/cubeUsage";
import { InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Skeleton } from "../ui/skeleton";
import {
  cubeUsageWindow,
  formatRunningTime,
  summarizeCubeUsage,
  type CubeUsagePeriod,
  type CubeUsageSummary,
} from "./cubeUsage";
import { niceScale } from "./UsageProviderChart";

const BACKEND_LABELS = { fly: "Fly.io", docker: "Docker" } as const;

/**
 * Running time and estimated cost of the cubes the selected environments
 * host, by period and by cube.
 */
export function CubeUsageSection({
  window,
  periods,
  selectedEnvironmentIds,
}: {
  readonly window: UsageSummaryInput;
  /** The page's days, or its rolling hour starts. */
  readonly periods: readonly string[];
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
}) {
  const resolution = window.resolution === "hour" ? "hour" : "day";
  const input = useMemo(() => cubeUsageWindow(window), [window]);
  const { hosts, isPending } = useCubeUsage(input, selectedEnvironmentIds);
  const summary = useMemo(
    () =>
      summarizeCubeUsage(
        hosts.flatMap((host) =>
          host.usage === null
            ? []
            : [{ environmentId: host.environmentId, label: host.label, usage: host.usage }],
        ),
        { resolution, periods, timeZone: window.timeZone },
      ),
    [hosts, periods, resolution, window.timeZone],
  );

  if (hosts.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">None of the selected environments host cubes.</p>
    );
  }
  if (isPending) return <CubeUsageSkeleton />;

  const formatPeriod = (period: string) =>
    resolution === "hour" ? formatHourShort(period, window.timeZone) : formatDayShort(period);
  const errors = hosts.flatMap((host) => (host.error ? [`${host.label}: ${host.error}`] : []));
  const flyOrganizations = [
    ...new Set(hosts.flatMap((host) => (host.flyOrganization ? [host.flyOrganization] : []))),
  ];

  return (
    <>
      {errors.map((error) => (
        <p key={error} className="mb-4 text-sm text-muted-foreground">
          {error}
        </p>
      ))}
      <section className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <div className="flex flex-col gap-1">
            <span className="text-4xl font-semibold text-foreground tabular-nums">
              {formatUsd(summary.costUsd)}
            </span>
            <span className="text-xs text-muted-foreground">
              {formatRunningTime(summary.runningSeconds)} running · Estimate{" "}
              <PricingNote summary={summary} />
            </span>
          </div>
          <BackendRows summary={summary} />
          {flyOrganizations.map((organization) => (
            <InlineButton
              key={organization}
              tone="muted"
              className="self-start text-xs"
              render={
                <a
                  href={`https://fly.io/dashboard/${encodeURIComponent(organization)}/billing`}
                  target="_blank"
                  rel="noopener noreferrer"
                />
              }
            >
              {flyOrganizations.length > 1 ? `${organization} billing on Fly` : "Billing on Fly"}
              <ArrowUpRightIcon aria-hidden className="size-3" />
            </InlineButton>
          ))}
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <h2 className="text-sm font-medium text-foreground">
            {resolution === "hour" ? "Hourly" : "Daily"} running time
          </h2>
          <CubeUsageChart periods={summary.periods} formatPeriod={formatPeriod} />
        </div>
      </section>

      <CubeTable summary={summary} showHost={hosts.length > 1} />
    </>
  );
}

function PricingNote({ summary }: { readonly summary: CubeUsageSummary }) {
  const pricing = summary.flyPricing;
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        render={<InlineButton tone="muted" />}
        aria-label="How cube cost is estimated"
      >
        <InfoIcon className="size-3" aria-hidden />
      </PopoverTrigger>
      <PopoverPopup side="top" tooltipStyle>
        Running time is recorded by the host every minute.{" "}
        {pricing === null
          ? "Fly cubes are priced at Fly's rates for their size and region."
          : pricing.source === "fly"
            ? `Fly cubes are priced at the rates Fly reported${
                pricing.checkedAt ? ` on ${formatDateTimeShort(pricing.checkedAt)}` : ""
              }, adjusted for region.`
            : "Fly cubes are priced at Fly's published rates for their size and region."}{" "}
        Docker cubes run on the host and are not charged. Storage for stopped cubes, a few cents a
        month, is not included. Fly does not report actual charges, so check your Fly bill for
        those.
      </PopoverPopup>
    </Popover>
  );
}

function BackendRows({ summary }: { readonly summary: CubeUsageSummary }) {
  const totals = (["fly", "docker"] as const).flatMap((backend) => {
    const cubes = summary.cubes.filter((cube) => cube.backend === backend);
    return cubes.length === 0
      ? []
      : [
          {
            backend,
            count: cubes.length,
            runningSeconds: cubes.reduce((sum, cube) => sum + cube.runningSeconds, 0),
            costUsd: cubes.reduce((sum, cube) => sum + cube.costUsd, 0),
          },
        ];
  });
  if (totals.length === 0) {
    return <p className="text-sm text-muted-foreground">No cube ran in this window.</p>;
  }
  return totals.map((total) => (
    <div key={total.backend} className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-4">
        <span className="flex min-w-0 items-baseline gap-1.5 text-sm text-foreground">
          <span className="truncate">{BACKEND_LABELS[total.backend]}</span>
          <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
            {total.count} {total.count === 1 ? "cube" : "cubes"}
          </span>
        </span>
        <span className="shrink-0 text-sm font-medium text-foreground tabular-nums">
          {total.backend === "docker" ? "No charge" : formatUsd(total.costUsd)}
        </span>
      </div>
      <span className="text-xs text-muted-foreground">
        {formatRunningTime(total.runningSeconds)} running
        {summary.runningSeconds > 0
          ? ` · ${formatPercent(total.runningSeconds / summary.runningSeconds)} of time`
          : ""}
      </span>
    </div>
  ));
}

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 260;
const BAR_GAP = 0.25;

/** Running hours per period as bars; hovering one reads out its time and cost. */
function CubeUsageChart({
  periods,
  formatPeriod,
}: {
  readonly periods: readonly CubeUsagePeriod[];
  readonly formatPeriod: (period: string) => string;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const peakHours =
    periods.reduce((peak, period) => Math.max(peak, period.runningSeconds), 0) / 3600;
  const { max, ticks } = niceScale(peakHours, 4);
  const slot = periods.length === 0 ? 0 : VIEW_WIDTH / periods.length;
  const focus = hovered === null ? undefined : periods[hovered];

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        <div className="relative h-56 w-14 shrink-0">
          {ticks.map((tick) => (
            <span
              key={tick}
              className="absolute right-0 -translate-y-1/2 text-3xs text-muted-foreground tabular-nums"
              style={{ top: `${max === 0 ? 100 : 100 - (tick / max) * 100}%` }}
            >
              {tick === 0 ? "0" : formatRunningTime(tick * 3600)}
            </span>
          ))}
        </div>
        <div className="relative h-56 flex-1" onMouseLeave={() => setHovered(null)}>
          <svg
            className="h-full w-full"
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label="Cube running time by period"
          >
            {ticks.map((tick) => {
              const y = max === 0 ? VIEW_HEIGHT : VIEW_HEIGHT - (tick / max) * VIEW_HEIGHT;
              return (
                <line
                  key={tick}
                  x1={0}
                  x2={VIEW_WIDTH}
                  y1={y}
                  y2={y}
                  stroke="currentColor"
                  strokeWidth={1}
                  className="text-border"
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
            {periods.map((period, index) => {
              const height = max === 0 ? 0 : (period.runningSeconds / 3600 / max) * VIEW_HEIGHT;
              return (
                <g key={period.period} onMouseEnter={() => setHovered(index)}>
                  {/* The full-height slot takes the hover, so short bars are easy to reach. */}
                  <rect
                    x={index * slot}
                    y={0}
                    width={slot}
                    height={VIEW_HEIGHT}
                    fill="transparent"
                  />
                  <rect
                    x={index * slot + (slot * BAR_GAP) / 2}
                    y={VIEW_HEIGHT - height}
                    width={slot * (1 - BAR_GAP)}
                    height={height}
                    className={hovered === index ? "fill-primary" : "fill-primary/60"}
                  />
                </g>
              );
            })}
          </svg>
        </div>
      </div>
      <div className="ml-16 flex min-h-4 justify-between gap-3 text-3xs text-muted-foreground tabular-nums">
        {focus === undefined ? (
          <>
            <span>{periods[0] ? formatPeriod(periods[0].period) : ""}</span>
            <span>{periods.at(-1) ? formatPeriod(periods.at(-1)!.period) : ""}</span>
          </>
        ) : (
          <span className="text-foreground">
            {formatPeriod(focus.period)} · {formatRunningTime(focus.runningSeconds)} ·{" "}
            {formatUsd(focus.costUsd)}
          </span>
        )}
      </div>
    </div>
  );
}

function CubeTable({
  summary,
  showHost,
}: {
  readonly summary: CubeUsageSummary;
  readonly showHost: boolean;
}) {
  const peak = summary.cubes.reduce((max, cube) => Math.max(max, cube.runningSeconds), 0);
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-foreground">Cubes</h2>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-right text-xs text-muted-foreground">
            <th className="w-full py-2 text-left font-normal">Cube</th>
            <th className="py-2 pl-6 text-left font-normal">Runs on</th>
            <th className="py-2 pl-6 font-normal">Running</th>
            <th className="py-2 pl-6 font-normal">Cost</th>
          </tr>
        </thead>
        <tbody>
          {summary.cubes.length === 0 ? (
            <tr>
              <td colSpan={4} className="py-6 text-center text-muted-foreground">
                No cube ran in this window.
              </td>
            </tr>
          ) : (
            summary.cubes.map((cube) => (
              <tr
                key={cube.key}
                className="border-b border-border/50 text-right whitespace-nowrap text-muted-foreground tabular-nums"
              >
                <td className="py-2.5 text-left whitespace-normal text-foreground">
                  {cube.label}
                  {showHost ? (
                    <span className="ml-1.5 text-xs text-muted-foreground">{cube.hostLabel}</span>
                  ) : null}
                  <div aria-hidden className="mt-1.5 h-0.5 max-w-48">
                    <div
                      className="h-full rounded-full bg-primary/60"
                      style={{
                        width: peak > 0 ? `max(0.5rem, ${(cube.runningSeconds / peak) * 100}%)` : 0,
                      }}
                    />
                  </div>
                </td>
                <td className="py-2.5 pl-6 text-left">{BACKEND_LABELS[cube.backend]}</td>
                <td className="py-2.5 pl-6">{formatRunningTime(cube.runningSeconds)}</td>
                <td className="py-2.5 pl-6 text-foreground">
                  {cube.backend === "docker" ? "—" : formatUsd(cube.costUsd)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </section>
  );
}

function CubeUsageSkeleton() {
  return (
    <>
      <section className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <Skeleton className="h-10 w-36" />
            <Skeleton className="h-4 w-32" />
          </div>
          <Skeleton className="h-9 w-full" />
        </div>
        <div className="flex flex-col gap-3">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="ml-16 h-56" />
        </div>
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-foreground">Cubes</h2>
        <Skeleton className="h-32" />
      </section>
    </>
  );
}
