import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { prepareProBrowserTool, runProPromptTool } from "../tools/proTools.js";
import { makeConfig } from "./testUtils.js";

const previousMode = process.env.MCP_PRO_BROWSER_MODE;
const previousMockResponse = process.env.MCP_PRO_MOCK_RESPONSE;
const previousChromeProfileDirectory = process.env.MCP_PRO_CHROME_PROFILE_DIRECTORY;
const previousAllowChromeRestart = process.env.MCP_PRO_ALLOW_CHROME_RESTART;
const previousForceChromeRestart = process.env.MCP_PRO_FORCE_CHROME_RESTART;

afterEach(() => {
  if (previousMode === undefined) {
    delete process.env.MCP_PRO_BROWSER_MODE;
  } else {
    process.env.MCP_PRO_BROWSER_MODE = previousMode;
  }
  if (previousMockResponse === undefined) {
    delete process.env.MCP_PRO_MOCK_RESPONSE;
  } else {
    process.env.MCP_PRO_MOCK_RESPONSE = previousMockResponse;
  }
  if (previousChromeProfileDirectory === undefined) {
    delete process.env.MCP_PRO_CHROME_PROFILE_DIRECTORY;
  } else {
    process.env.MCP_PRO_CHROME_PROFILE_DIRECTORY = previousChromeProfileDirectory;
  }
  if (previousAllowChromeRestart === undefined) {
    delete process.env.MCP_PRO_ALLOW_CHROME_RESTART;
  } else {
    process.env.MCP_PRO_ALLOW_CHROME_RESTART = previousAllowChromeRestart;
  }
  if (previousForceChromeRestart === undefined) {
    delete process.env.MCP_PRO_FORCE_CHROME_RESTART;
  } else {
    process.env.MCP_PRO_FORCE_CHROME_RESTART = previousForceChromeRestart;
  }
});

describe("pro tools", () => {
  it("requires explicit confirmation before sending prompt content externally", async () => {
    const config = makeConfig();
    await expect(
      runProPromptTool(config, {
        prompt: "plan this",
        confirmSendToChatGpt: false,
      }),
    ).rejects.toThrow("confirmSendToChatGpt");
  });

  it("writes request and response artifacts in mock mode", async () => {
    process.env.MCP_PRO_BROWSER_MODE = "mock";
    process.env.MCP_PRO_MOCK_RESPONSE = "codex-gptpro pro mock ok";
    const config = makeConfig();

    const result = await runProPromptTool(config, {
      prompt: "Return a short plan.",
      title: "Mock Pro Plan",
      modelLabel: "5.5 Pro 拡張",
      confirmSendToChatGpt: true,
    });

    expect(result.backend).toBe("mock");
    expect(result.modelLabel).toBe("Pro 拡張");
    expect(result.responseText).toBe("codex-gptpro pro mock ok");
    expect(result.requestPath).toBeTruthy();
    expect(result.responsePath).toBeTruthy();
    expect(fs.readFileSync(result.requestPath ?? "", "utf8")).toContain("Return a short plan.");
    expect(fs.readFileSync(result.responsePath ?? "", "utf8")).toContain(
      "codex-gptpro pro mock ok",
    );
  });

  it("prepares browser successfully in mock mode", async () => {
    process.env.MCP_PRO_BROWSER_MODE = "mock";

    const result = await prepareProBrowserTool({
      chromeProfileDirectory: "Profile 1",
      allowChromeRestart: true,
      forceChromeRestart: true,
    });

    expect(result.mode).toBe("mock");
    expect(result.chromeProfileDirectory).toBe("Profile 1");
    expect(result.chromeRestartAllowed).toBe(true);
    expect(result.chromeForceRestartAllowed).toBe(true);
    expect(result.loginRequired).toBe(false);
    expect(result.instructions.join(" ")).toContain("Mock mode");
  });
});
