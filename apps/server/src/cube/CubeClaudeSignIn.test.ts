import { describe, expect, it } from "vite-plus/test";

import { extractSetupToken, visibleOutput } from "./CubeClaudeSignIn.ts";

const TOKEN = `sk-ant-oat01-${"Ab3_-".repeat(20)}xyz`;

// What `claude setup-token` prints once the browser step is done, with its
// terminal UI's colours and the token wrapped at 80 columns.
const success =
  "\x1b[32m✓ Long-lived authentication token created successfully!\x1b[39m\r\n\r\n" +
  "Your OAuth token (valid for 1 year):\r\n\r\n" +
  `\x1b[33m${TOKEN.slice(0, 80)}\r\n${TOKEN.slice(80)}\x1b[39m\r\n\r\n` +
  "\x1b[2mStore this token securely. You won't be able to see it again.\x1b[22m\r\n";

describe("visibleOutput", () => {
  it("shows the sign-in steps but stops before the token", () => {
    const steps = "Browser didn't open? Use the url below\r\nPaste code here if prompted > ";
    const shown = visibleOutput(steps + success);
    expect(shown.startsWith(steps)).toBe(true);
    expect(shown).not.toContain("sk-ant-oat");
    expect(shown).not.toContain(TOKEN.slice(20, 40));
  });

  it("stops before anything shaped like a token if the wording changes", () => {
    expect(visibleOutput(`Here you go: ${TOKEN}`)).toBe("Here you go: ");
  });
});

describe("extractSetupToken", () => {
  it("reads a token the terminal wrapped across lines", () => {
    expect(extractSetupToken(`Paste code here if prompted > abc\r\n${success}`)).toBe(TOKEN);
  });

  it("finds nothing when the sign-in did not finish", () => {
    expect(extractSetupToken("Paste code here if prompted > \r\nOAuth error: denied")).toBeNull();
  });
});
