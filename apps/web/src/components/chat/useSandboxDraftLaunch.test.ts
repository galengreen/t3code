import { describe, expect, it } from "vite-plus/test";

import {
  advanceSandboxLaunch,
  failSandboxLaunch,
  sandboxLabelFromPrompt,
} from "./useSandboxDraftLaunch";

describe("sandboxLabelFromPrompt", () => {
  it("uses the first non-empty line", () => {
    expect(sandboxLabelFromPrompt("\n  Fix the login redirect  \nmore detail")).toBe(
      "Fix the login redirect",
    );
  });

  it("shortens long lines with an ellipsis", () => {
    const label = sandboxLabelFromPrompt("a".repeat(80));
    expect(label).toHaveLength(48);
    expect(label?.endsWith("…")).toBe(true);
  });

  it("has no label for an empty prompt", () => {
    expect(sandboxLabelFromPrompt("   \n ")).toBeUndefined();
  });
});

describe("sandbox launch stages", () => {
  it("finishes earlier stages as the launch moves on and keeps their times", () => {
    const created = advanceSandboxLaunch({ phase: "idle" }, "create", 1_000);
    const connecting = advanceSandboxLaunch(created, "connect", 31_000);
    const sending = advanceSandboxLaunch(connecting, "send", 33_000);
    expect(sending).toEqual({
      phase: "starting",
      startedAt: 1_000,
      error: null,
      stages: [
        { id: "create", status: "done", startedAt: 1_000, endedAt: 31_000 },
        { id: "connect", status: "done", startedAt: 31_000, endedAt: 33_000 },
        { id: "send", status: "running", startedAt: 33_000, endedAt: null },
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
