import { EnvironmentId, type CubeUsageBucket, UsageDay } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  cubeUsageWindow,
  formatRunningTime,
  summarizeCubeUsage,
  type HostCubeUsage,
} from "./cubeUsage";

const bucket = (
  hourStart: string,
  cubeId: string,
  runningSeconds: number,
  costUsd = 0,
  backend: "docker" | "fly" = costUsd > 0 ? "fly" : "docker",
): CubeUsageBucket => ({
  hourStart,
  cubeId,
  label: `Cube ${cubeId}`,
  backend,
  runningSeconds,
  costUsd,
});

const host = (
  id: string,
  buckets: readonly CubeUsageBucket[],
  source: "fly" | "builtIn" = "builtIn",
): HostCubeUsage => ({
  environmentId: EnvironmentId.make(id),
  label: id,
  usage: { buckets, pricing: { source, checkedAt: null } },
});

describe("summarizeCubeUsage", () => {
  it("puts hours on the viewer's calendar days", () => {
    // 11:00 UTC on the 5th is already the 6th in Auckland (UTC+13).
    const summary = summarizeCubeUsage(
      [
        host("host", [
          bucket("2026-10-05T10:00:00.000Z", "aaaaaaaa", 600, 0.1),
          bucket("2026-10-05T11:00:00.000Z", "aaaaaaaa", 1200, 0.2),
          bucket("2026-10-04T05:00:00.000Z", "bbbbbbbb", 3600),
        ]),
      ],
      { resolution: "day", periods: ["2026-10-05", "2026-10-06"], timeZone: "Pacific/Auckland" },
    );
    expect(summary.periods).toEqual([
      { period: "2026-10-05", runningSeconds: 600, costUsd: 0.1 },
      { period: "2026-10-06", runningSeconds: 1200, costUsd: 0.2 },
    ]);
    // Hours outside the window's days are left out of every total.
    expect(summary.runningSeconds).toBe(1800);
    expect(summary.cubes.map((cube) => cube.label)).toEqual(["Cube aaaaaaaa"]);
  });

  it("counts each hour toward the rolling period it ends in", () => {
    const summary = summarizeCubeUsage(
      [
        host("host", [
          bucket("2026-10-06T09:00:00.000Z", "aaaaaaaa", 300),
          bucket("2026-10-06T10:00:00.000Z", "aaaaaaaa", 600),
          bucket("2026-10-06T11:00:00.000Z", "aaaaaaaa", 900),
        ]),
      ],
      {
        resolution: "hour",
        periods: ["2026-10-06T09:26:00.000Z", "2026-10-06T10:26:00.000Z"],
        timeZone: "UTC",
      },
    );
    // 09:00 joins the first period, and the hour in progress the last.
    expect(summary.periods.map((period) => period.runningSeconds)).toEqual([300, 1500]);
  });

  it("keeps the same cube id on two hosts apart and ranks by cost", () => {
    const summary = summarizeCubeUsage(
      [
        host("one", [bucket("2026-10-06T09:00:00.000Z", "aaaaaaaa", 7200)]),
        host("two", [bucket("2026-10-06T09:00:00.000Z", "aaaaaaaa", 60, 0.5)], "fly"),
      ],
      { resolution: "day", periods: ["2026-10-06"], timeZone: "UTC" },
    );
    expect(summary.cubes.map((cube) => [cube.hostLabel, cube.runningSeconds])).toEqual([
      ["two", 60],
      ["one", 7200],
    ]);
    expect(summary.flyPricing?.source).toBe("fly");
  });
});

describe("cubeUsageWindow", () => {
  it("covers a day window's first day in every time zone", () => {
    expect(
      cubeUsageWindow({
        sinceDay: UsageDay.make("2026-10-05"),
        untilDay: UsageDay.make("2026-10-06"),
        timeZone: "Pacific/Auckland",
      }),
    ).toEqual({
      sinceTime: "2026-10-04T10:00:00.000Z",
      untilTime: "2026-10-07T14:00:00.000Z",
    });
  });
});

describe("formatRunningTime", () => {
  it("rounds to the precision a bill cares about", () => {
    expect(formatRunningTime(0)).toBe("0h");
    expect(formatRunningTime(20)).toBe("1m");
    expect(formatRunningTime(45 * 60)).toBe("45m");
    expect(formatRunningTime(3.24 * 3600)).toBe("3.2h");
    expect(formatRunningTime(128.4 * 3600)).toBe("128h");
  });
});
