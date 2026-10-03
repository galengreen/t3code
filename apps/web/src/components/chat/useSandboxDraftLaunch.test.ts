import { describe, expect, it } from "vite-plus/test";

import { sandboxLabelFromPrompt } from "./useSandboxDraftLaunch";

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
