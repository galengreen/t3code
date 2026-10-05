import { describe, expect, it } from "vite-plus/test";

import { advanceSandboxLaunch, failSandboxLaunch } from "./useSandboxDraftLaunch";

describe("sandbox launch stages", () => {
  it("finishes earlier stages as the launch moves on and keeps their times", () => {
    const created = advanceSandboxLaunch({ phase: "idle" }, "create", 1_000);
    const connecting = advanceSandboxLaunch(created, "connect", 3_000);
    const cloning = advanceSandboxLaunch(connecting, "clone", 4_000);
    const sending = advanceSandboxLaunch(cloning, "send", 9_000);
    expect(sending).toEqual({
      phase: "starting",
      startedAt: 1_000,
      error: null,
      stages: [
        { id: "create", status: "done", startedAt: 1_000, endedAt: 3_000 },
        { id: "connect", status: "done", startedAt: 3_000, endedAt: 4_000 },
        { id: "clone", status: "done", startedAt: 4_000, endedAt: 9_000 },
        { id: "send", status: "running", startedAt: 9_000, endedAt: null },
      ],
    });
  });

  it("fails only the running stage and keeps the reason", () => {
    const connecting = advanceSandboxLaunch(
      advanceSandboxLaunch({ phase: "idle" }, "create", 0),
      "connect",
      10,
    );
    const failed = failSandboxLaunch(connecting, "Fly could not find the image.", 25);
    expect(failed).toMatchObject({
      phase: "failed",
      error: "Fly could not find the image.",
      stages: [
        { id: "create", status: "done" },
        { id: "connect", status: "failed", endedAt: 25 },
        { id: "clone", status: "pending" },
        { id: "send", status: "pending" },
      ],
    });
  });

  it("starts over cleanly when retried after a failure", () => {
    const failed = failSandboxLaunch(advanceSandboxLaunch({ phase: "idle" }, "create", 0), "x", 5);
    const retried = advanceSandboxLaunch({ phase: "idle" }, "create", 100);
    expect(failed.phase).toBe("failed");
    expect(retried).toMatchObject({ phase: "starting", startedAt: 100, error: null });
  });
});
