// @effect-diagnostics globalDate:off -- Buckets are placed on the viewer's calendar via Intl.
import type {
  CubeUsage,
  CubeUsageInput,
  CubeUsagePricing,
  EnvironmentId,
  UsageSummaryInput,
} from "@t3tools/contracts";

const HOUR_MS = 3_600_000;
/** No zone is further ahead of UTC than this, so a day window never misses its first hours. */
const MAX_ZONE_LEAD_MS = 14 * HOUR_MS;

export interface HostCubeUsage {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly usage: CubeUsage;
}

export interface CubeUsagePeriod {
  readonly period: string;
  readonly runningSeconds: number;
  readonly costUsd: number;
}

export interface CubeUsageRow {
  readonly key: string;
  readonly label: string;
  readonly backend: "docker" | "fly";
  readonly hostLabel: string;
  readonly runningSeconds: number;
  readonly costUsd: number;
}

export interface CubeUsageSummary {
  readonly runningSeconds: number;
  readonly costUsd: number;
  readonly periods: readonly CubeUsagePeriod[];
  /** Most expensive first, then longest running. */
  readonly cubes: readonly CubeUsageRow[];
  /** Fly pricing of the hosts that ran Fly cubes; null when none did. */
  readonly flyPricing: CubeUsagePricing | null;
}

/**
 * The instants the page's window covers. Day windows start at the earliest
 * moment the first day could begin; buckets outside the viewer's days are
 * dropped when summarising.
 */
export function cubeUsageWindow(window: UsageSummaryInput): CubeUsageInput {
  if (window.sinceTime !== undefined && window.untilTime !== undefined) {
    return { sinceTime: window.sinceTime, untilTime: window.untilTime };
  }
  const since = Date.parse(`${window.sinceDay}T00:00:00Z`) - MAX_ZONE_LEAD_MS;
  const until = Date.parse(`${window.untilDay}T00:00:00Z`) + 24 * HOUR_MS + MAX_ZONE_LEAD_MS;
  return { sinceTime: new Date(since).toISOString(), untilTime: new Date(until).toISOString() };
}

/**
 * Totals per period (the page's days, or its rolling hours) and per cube.
 * Rolling hours start mid-hour, so each recorded hour counts toward the period
 * it ends in: the hour the window starts in joins the first period, and the
 * hour in progress the last.
 */
export function summarizeCubeUsage(
  hosts: readonly HostCubeUsage[],
  window: {
    readonly resolution: "day" | "hour";
    readonly periods: readonly string[];
    readonly timeZone: string;
  },
): CubeUsageSummary {
  const dayFormat = new Intl.DateTimeFormat("en-CA", {
    timeZone: window.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const firstPeriodStart = window.resolution === "hour" ? Date.parse(window.periods[0] ?? "") : NaN;
  const periodIndex = new Map(window.periods.map((period, index) => [period, index]));
  const periodOf = (hourStart: string): number | undefined => {
    if (window.periods.length === 0) return undefined;
    if (window.resolution === "day")
      return periodIndex.get(dayFormat.format(Date.parse(hourStart)));
    const index = Math.ceil((Date.parse(hourStart) - firstPeriodStart) / HOUR_MS);
    return Math.min(window.periods.length - 1, Math.max(0, index));
  };

  const periods = window.periods.map((period) => ({ period, runningSeconds: 0, costUsd: 0 }));
  const cubes = new Map<string, CubeUsageRow & { runningSeconds: number; costUsd: number }>();
  let flyPricing: CubeUsagePricing | null = null;
  for (const host of hosts) {
    for (const bucket of host.usage.buckets) {
      const index = periodOf(bucket.hourStart);
      if (index === undefined) continue;
      periods[index]!.runningSeconds += bucket.runningSeconds;
      periods[index]!.costUsd += bucket.costUsd;
      const key = `${host.environmentId}:${bucket.cubeId}`;
      const row = cubes.get(key) ?? {
        key,
        label: bucket.label,
        backend: bucket.backend,
        hostLabel: host.label,
        runningSeconds: 0,
        costUsd: 0,
      };
      row.runningSeconds += bucket.runningSeconds;
      row.costUsd += bucket.costUsd;
      cubes.set(key, row);
      // Fly's own rates win over built-in ones when hosts disagree.
      if (bucket.backend === "fly" && flyPricing?.source !== "fly") flyPricing = host.usage.pricing;
    }
  }
  return {
    runningSeconds: periods.reduce((sum, period) => sum + period.runningSeconds, 0),
    costUsd: periods.reduce((sum, period) => sum + period.costUsd, 0),
    periods,
    cubes: [...cubes.values()].toSorted(
      (a, b) => b.costUsd - a.costUsd || b.runningSeconds - a.runningSeconds,
    ),
    flyPricing,
  };
}

/** `45m`, `3.2h`, `128h`: running time at the precision a bill cares about. */
export function formatRunningTime(seconds: number): string {
  if (seconds <= 0) return "0h";
  if (seconds < HOUR_MS / 1000) return `${Math.max(1, Math.round(seconds / 60))}m`;
  const hours = seconds / 3600;
  return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)}h`;
}
