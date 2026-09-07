import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import { z } from "zod";
import type { AppConfig } from "../core/config.js";
import { ensureRepoWorkspace } from "../core/paths.js";
import { slugify, truncateText } from "../core/sanitize.js";

export const proBrowserStatusInputSchema = {};

export const prepareProBrowserInputSchema = {
  chatgptUrl: z.string().url().optional(),
  cdpEndpoint: z.string().url().optional(),
  chromeProfileDirectory: z.string().min(1).max(120).optional(),
  allowChromeRestart: z.boolean().optional(),
  forceChromeRestart: z.boolean().optional(),
  keepBrowserOpen: z.boolean().optional(),
};

export const runProPromptInputSchema = {
  prompt: z.string().min(1).max(180_000),
  title: z.string().min(1).max(160).optional(),
  modelLabel: z.string().min(1).max(80).optional(),
  chatgptUrl: z.string().url().optional(),
  cdpEndpoint: z.string().url().optional(),
  chromeProfileDirectory: z.string().min(1).max(120).optional(),
  allowChromeRestart: z.boolean().optional(),
  forceChromeRestart: z.boolean().optional(),
  timeoutSec: z.number().int().min(30).max(1800).optional(),
  pollIntervalSec: z.number().int().min(2).max(30).optional(),
  maxResponseBytes: z.number().int().min(1_000).max(500_000).optional(),
  save: z.boolean().optional(),
  keepBrowserOpen: z.boolean().optional(),
  artifactSlug: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{1,100}$/)
    .optional(),
  confirmSendToChatGpt: z.boolean(),
};

type RunProPromptInput = z.infer<z.ZodObject<typeof runProPromptInputSchema>>;
type PrepareProBrowserInput = z.infer<z.ZodObject<typeof prepareProBrowserInputSchema>>;
type BrowserBackend = "mock" | "chrome-applescript" | "playwright-chrome";

type BrowserRunResult = {
  backend: BrowserBackend;
  pageText: string;
  responseText: string;
  durationMs: number;
  verifiedModelLabel?: string;
};

const DEFAULT_MODEL_LABEL = "Pro 拡張";
const DEFAULT_CHATGPT_URL = "https://chatgpt.com/";
const DEFAULT_TIMEOUT_SEC = 900;
const DEFAULT_POLL_INTERVAL_SEC = 5;
const DEFAULT_MAX_RESPONSE_BYTES = 200_000;
const DEFAULT_BROWSER_MODE: BrowserBackend = "playwright-chrome";
const DEFAULT_CHROME_PROFILE_DIRECTORY = "codex-gptpro";
const DEFAULT_CHROME_AUTOMATION_USER_DATA_DIR = path.join(
  os.homedir(),
  ".codex-gptpro/chrome-user-data",
);

function modelLabel(inputLabel?: string): string {
  const label = inputLabel || process.env.MCP_PRO_MODEL_LABEL || DEFAULT_MODEL_LABEL;
  if (/5[.\s-]?5/iu.test(label) && /pro/iu.test(label) && /拡張|extension/iu.test(label)) {
    return "Pro 拡張";
  }
  return label;
}

function proBrowserMode(): BrowserBackend {
  const mode = process.env.MCP_PRO_BROWSER_MODE || DEFAULT_BROWSER_MODE;
  if (mode === "mock" || mode === "chrome-applescript" || mode === "playwright-chrome") {
    return mode;
  }
  throw new Error(
    "MCP_PRO_BROWSER_MODE must be one of: playwright-chrome, chrome-applescript, mock",
  );
}

function chromeProfilesRoot(): string {
  return path.join(os.homedir(), "Library/Application Support/Google/Chrome");
}

function chromeProfileDirectory(inputDirectory?: string): string {
  const directory =
    inputDirectory ||
    process.env.MCP_PRO_CHROME_PROFILE_DIRECTORY ||
    DEFAULT_CHROME_PROFILE_DIRECTORY;
  if (directory.includes("/") || directory.includes("\\") || directory.includes("..")) {
    throw new Error("Chrome profile directory must be a simple profile directory name");
  }
  return directory;
}

function useSystemChromeProfile(): boolean {
  return process.env.MCP_PRO_USE_SYSTEM_CHROME_PROFILE === "true";
}

function chromeUserDataDir(): string | undefined {
  if (useSystemChromeProfile()) {
    return undefined;
  }
  return path.resolve(
    process.env.MCP_PRO_CHROME_AUTOMATION_USER_DATA_DIR ||
      process.env.MCP_PRO_CHROME_USER_DATA_DIR ||
      DEFAULT_CHROME_AUTOMATION_USER_DATA_DIR,
  );
}

function allowChromeRestart(inputAllow?: boolean): boolean {
  return inputAllow === true || process.env.MCP_PRO_ALLOW_CHROME_RESTART === "true";
}

function forceChromeRestart(inputForce?: boolean): boolean {
  return inputForce === true || process.env.MCP_PRO_FORCE_CHROME_RESTART === "true";
}

function configuredCdpEndpoint(inputEndpoint?: string): string | undefined {
  const endpoint = inputEndpoint || process.env.MCP_PRO_CDP_ENDPOINT;
  if (!endpoint) {
    return undefined;
  }
  const url = new URL(endpoint);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error("CDP endpoint must be localhost-only");
  }
  if (url.protocol !== "http:" && url.protocol !== "ws:") {
    throw new Error("CDP endpoint must use http:// or ws://");
  }
  return endpoint;
}

function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true });
  let current = path.parse(directory).root;
  for (const segment of path.relative(current, directory).split(path.sep)) {
    current = path.join(current, segment);
    if (current === os.homedir()) {
      continue;
    }
    if (current.includes(`${path.sep}.codex-gptpro`)) {
      fs.chmodSync(current, 0o700);
    }
  }
}

function ensurePrivateRepoDirectory(directory: string): void {
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    return;
  }
  const stat = fs.statSync(directory);
  if (!stat.isDirectory()) {
    throw new Error(`Expected directory but found non-directory path: ${directory}`);
  }
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && stat.uid === currentUid && (stat.mode & 0o700) !== 0o700) {
    fs.chmodSync(directory, 0o700);
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function googleChromeProcesses(): Array<{ pid: number; command: string }> {
  const result = spawnSync("ps", ["axo", "pid=,command="], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0) {
    return [];
  }
  return result.stdout.split(/\r?\n/).flatMap((line) => {
    const match = line.trimStart().match(/^(\d+)\s+(.+)$/u);
    if (!match?.[1] || !match[2]) {
      return [];
    }
    const pid = Number.parseInt(match[1], 10);
    const command = match[2];
    if (
      Number.isInteger(pid) &&
      command.includes("Google Chrome.app/Contents/MacOS/Google Chrome") &&
      !line.includes("Google Chrome Helper.app") &&
      !line.includes("--headless") &&
      !line.includes("playwright_chromiumdev_profile")
    ) {
      return [{ pid, command }];
    }
    return [];
  });
}

function googleChromeProcessCommands(): string[] {
  return googleChromeProcesses().map((processInfo) => processInfo.command);
}

function isGoogleChromeRunning(): boolean {
  return googleChromeProcessCommands().length > 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findFreeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate local CDP port")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function timestampId(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function quoteAppleScriptString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function runAppleScript(script: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("osascript", ["-"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`Chrome Pro automation timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trimEnd());
        return;
      }
      reject(new Error(formatAppleScriptError(stderr || stdout || `osascript exited ${code}`)));
    });
    child.stdin.end(script);
  });
}

function formatAppleScriptError(raw: string): string {
  if (raw.includes("-1743") || raw.includes("権限がありません")) {
    return [
      "Chrome Pro automation requires macOS Automation/Accessibility permission.",
      "Grant the process running codex-gptpro permission to control Google Chrome and System Events.",
      "System Settings > Privacy & Security > Accessibility and Automation.",
      `Raw error: ${raw.trim()}`,
    ].join(" ");
  }
  return raw.trim();
}

function chromeAppleScript(input: {
  promptPath: string;
  outputPath: string;
  modelLabel: string;
  chatgptUrl: string;
  timeoutSec: number;
  pollIntervalSec: number;
}): string {
  const promptPath = quoteAppleScriptString(input.promptPath);
  const outputPath = quoteAppleScriptString(input.outputPath);
  const modelLabel = quoteAppleScriptString(input.modelLabel);
  const chatgptUrl = quoteAppleScriptString(input.chatgptUrl);

  return `
set promptPath to ${promptPath}
set outputPath to ${outputPath}
set modelLabel to ${modelLabel}
set chatgptUrl to ${chatgptUrl}
set timeoutSec to ${input.timeoutSec}
set pollIntervalSec to ${input.pollIntervalSec}
set promptText to read POSIX file promptPath as «class utf8»
set previousClipboard to ""
try
  set previousClipboard to the clipboard as text
end try

tell application "Google Chrome"
  activate
  if not (exists window 1) then make new window
  tell window 1 to make new tab with properties {URL:chatgptUrl}
end tell

delay 4

tell application "System Events"
  tell process "Google Chrome"
    set frontmost to true
    set modelVisible to false
    repeat with i from 1 to 20
      if my existsUiText(window 1, modelLabel) then
        set modelVisible to true
        exit repeat
      end if
      delay 1
    end repeat
    if modelVisible is false then error "ChatGPT model label was not visible: " & modelLabel

    set inputClicked to false
    repeat with i from 1 to 20
      if my clickUiText(window 1, "ChatGPT とチャットする") then
        set inputClicked to true
        exit repeat
      end if
      if my clickUiText(window 1, "質問してみましょう") then
        set inputClicked to true
        exit repeat
      end if
      delay 1
    end repeat
    if inputClicked is false then error "ChatGPT prompt input was not visible"

    set the clipboard to promptText
    keystroke "v" using command down
    delay 0.5

    if not my clickUiText(window 1, "プロンプトを送信する") then
      key code 36
    end if
  end tell
end tell

set startedAt to current date
set pageText to ""
repeat
  delay pollIntervalSec
  set pageText to my copyPageText()
  if pageText does not contain "Pro が思考中です" and pageText does not contain "停止" and pageText does not contain "Stop generating" then
    exit repeat
  end if
  if ((current date) - startedAt) > timeoutSec then error "Timed out waiting for ChatGPT Pro response"
end repeat

my writeUtf8(outputPath, pageText)
try
  set the clipboard to previousClipboard
end try
return outputPath

on copyPageText()
  tell application "System Events"
    tell process "Google Chrome"
      keystroke "a" using command down
      delay 0.1
      keystroke "c" using command down
      delay 0.2
    end tell
  end tell
  try
    return the clipboard as text
  on error
    return ""
  end try
end copyPageText

on writeUtf8(targetPath, textValue)
  set fileRef to open for access POSIX file targetPath with write permission
  try
    set eof of fileRef to 0
    write textValue to fileRef as «class utf8»
    close access fileRef
  on error errMsg
    try
      close access fileRef
    end try
    error errMsg
  end try
end writeUtf8

on existsUiText(rootElement, targetText)
  set foundElement to my findUiText(rootElement, targetText)
  if foundElement is missing value then return false
  return true
end existsUiText

on clickUiText(rootElement, targetText)
  set foundElement to my findUiText(rootElement, targetText)
  if foundElement is missing value then return false
  try
    tell application "System Events" to click foundElement
    return true
  on error
    return false
  end try
end clickUiText

on findUiText(rootElement, targetText)
  tell application "System Events"
    try
      set elementName to name of rootElement as text
      if elementName contains targetText then return rootElement
    end try
    try
      set elementDescription to description of rootElement as text
      if elementDescription contains targetText then return rootElement
    end try
    try
      set elementValue to value of rootElement as text
      if elementValue contains targetText then return rootElement
    end try
    try
      repeat with childElement in UI elements of rootElement
        set foundElement to my findUiText(childElement, targetText)
        if foundElement is not missing value then return foundElement
      end repeat
    end try
  end tell
  return missing value
end findUiText
`;
}

function extractResponseText(pageText: string, prompt: string): string {
  const promptIndex = pageText.lastIndexOf(prompt);
  const afterPrompt = promptIndex >= 0 ? pageText.slice(promptIndex + prompt.length) : pageText;
  return afterPrompt
    .replace(/ChatGPT の回答は必ずしも正しいとは限りません[\s\S]*$/u, "")
    .replace(/ChatGPT can make mistakes[\s\S]*$/u, "")
    .trim();
}

function writeArtifacts(
  config: AppConfig,
  input: RunProPromptInput,
  result: BrowserRunResult,
  options: { runId: string; modelLabel: string; response: { text: string; truncated: boolean } },
): {
  requestPath: string;
  responsePath: string;
} {
  ensureRepoWorkspace(config.repoRoot);
  const codexDir = path.join(config.repoRoot, ".codex");
  const proPlanDir = path.join(codexDir, "pro-plan");
  ensurePrivateRepoDirectory(codexDir);
  ensurePrivateRepoDirectory(proPlanDir);
  const requestDir = path.join(proPlanDir, "requests");
  const responseDir = path.join(config.repoRoot, ".ai/pro-outputs");
  ensurePrivateRepoDirectory(requestDir);
  fs.mkdirSync(responseDir, { recursive: true });
  const baseSlug = input.artifactSlug || slugify(input.title || "pro-prompt", "pro-prompt");
  const fileBase = `PRO-${timestampId()}-${baseSlug}`;
  const requestPath = path.join(requestDir, `${options.runId}.json`);
  const responsePath = path.join(responseDir, `${fileBase}.md`);
  fs.writeFileSync(
    requestPath,
    `${JSON.stringify(
      {
        runId: options.runId,
        createdAt: new Date().toISOString(),
        title: input.title ?? null,
        modelLabel: options.modelLabel,
        chatgptUrl: input.chatgptUrl ?? DEFAULT_CHATGPT_URL,
        prompt: input.prompt,
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  fs.writeFileSync(
    responsePath,
    [
      "---",
      `run_id: ${options.runId}`,
      `model_label: ${JSON.stringify(options.modelLabel)}`,
      `backend: ${result.backend}`,
      `completed_at: ${JSON.stringify(new Date().toISOString())}`,
      `duration_ms: ${result.durationMs}`,
      `response_truncated: ${options.response.truncated}`,
      "---",
      "",
      "# Prompt",
      "",
      input.prompt,
      "",
      "# Response",
      "",
      options.response.text,
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );
  return { requestPath, responsePath };
}

async function runMockBrowser(input: RunProPromptInput): Promise<BrowserRunResult> {
  const started = Date.now();
  const responseText = process.env.MCP_PRO_MOCK_RESPONSE || "codex-gptpro pro mock response";
  return {
    backend: "mock",
    pageText: `${input.prompt}\n${responseText}`,
    responseText,
    durationMs: Date.now() - started,
  };
}

async function readPageText(page: Page): Promise<string> {
  try {
    return await page.locator("body").innerText({ timeout: 5_000 });
  } catch {
    return await page.content();
  }
}

async function selectModelLabel(page: Page, modelLabel: string): Promise<string> {
  const exactLabel = new RegExp(`^${escapeRegex(modelLabel)}$`, "iu");
  const labelPattern = new RegExp(`(?:^|\\s)${escapeRegex(modelLabel)}(?:$|\\s)`, "iu");
  const modelButton = page.locator('button[data-testid="model-switcher-dropdown-button"]:visible');
  const effortButton = page
    .locator('button[aria-haspopup="menu"]:visible')
    .filter({ hasText: exactLabel });
  // New composers show a version and effort (e.g. "6 Pro") while collapsed.
  // Use this only to open the menu; verify the selected effort inside it below.
  const versionedEffortButton = page
    .locator('button[aria-haspopup="menu"]:visible')
    .filter({ hasText: /^\s*(?:GPT[-\s]*)?\d+(?:\.\d+)?\s*(?:Auto|Instant|Thinking|Pro)\s*$/iu });
  const thinkingButton = page.getByRole("button", {
    name: /^(?:思考强度|思考強度|推理强度|推理強度|Thinking(?: effort| time| strength)?|Reasoning(?: effort)?|思考時間)$/iu,
  });
  const checkedOptions = page.locator(
    '[role="menuitemradio"][aria-checked="true"]:visible, [role="radio"][aria-checked="true"]:visible, [role="option"][aria-selected="true"]:visible',
  );
  const popup = page.locator(
    '[role="menu"]:visible, [role="dialog"]:visible, [data-radix-popper-content-wrapper]:visible',
  );

  const selectedLabel = async (): Promise<string | undefined> => {
    if (await effortButton.count()) return (await effortButton.first().innerText()).trim();
    if (await modelButton.count()) {
      const text = (await modelButton.first().innerText()).trim();
      if (labelPattern.test(text)) return text;
    }
    for (const text of await checkedOptions.allInnerTexts()) {
      if (labelPattern.test(text.trim())) return text.trim();
    }
    // The current ChatGPT composer displays its selected effort above a slider.
    // Require both the Pro label inside that popup and the slider's maximum value;
    // a subscription badge or a sidebar chat title is never selection evidence.
    if (exactLabel.test("Pro")) {
      for (const panel of await popup.all()) {
        // The new custom power control hides its ARIA slider from the
        // accessibility tree, but retains the selected value in the open menu.
        const slider = panel.getByRole("slider", { includeHidden: true });
        if ((await slider.count()) !== 1 || !(await panel.getByText(exactLabel).count())) continue;
        const value = await slider.getAttribute("aria-valuenow");
        const maximum = await slider.getAttribute("aria-valuemax");
        if (value !== null && maximum !== null && value === maximum) return "Pro";
      }
    }
    return undefined;
  };

  let selected = await selectedLabel();
  if (selected) {
    await page.keyboard.press("Escape");
    return selected;
  }
  if (await thinkingButton.count()) {
    await thinkingButton.first().click({ timeout: 10_000 });
  } else if (await versionedEffortButton.count()) {
    await versionedEffortButton.first().click({ timeout: 10_000 });
  } else if (await modelButton.count()) {
    await modelButton.first().click({ timeout: 10_000 });
  } else {
    const controls = [];
    for (const button of await page.locator('button:visible, [role="button"]:visible').all()) {
      const label = (
        (await button.getAttribute("aria-label")) || (await button.innerText())
      ).trim();
      if (/^(?:\d|Pro$|思考|Thinking|发送|Send|ChatGPT|GPT)/iu.test(label)) {
        controls.push({
          label: label.slice(0, 120),
          testId: await button.getAttribute("data-testid"),
          popup: await button.getAttribute("aria-haspopup"),
        });
      }
    }
    throw new Error(
      `ChatGPT model control was not found; selection not verified: ${modelLabel}. Controls: ${JSON.stringify(controls.slice(0, 12))}`,
    );
  }

  selected = await selectedLabel();
  if (!selected) {
    const modelOption = popup.getByText(exactLabel).first();
    try {
      await modelOption.click({ timeout: 5_000 });
    } catch {
      throw new Error(`ChatGPT model option was not clickable: ${modelLabel}`);
    }
    selected = await selectedLabel();
  }
  if (!selected) {
    const panels = [];
    for (const panel of await popup.all()) {
      const sliders = [];
      for (const slider of await panel
        .locator("[aria-valuenow], input, [aria-roledescription]")
        .all()) {
        sliders.push({
          role: await slider.getAttribute("role"),
          type: await slider.getAttribute("type"),
          description: await slider.getAttribute("aria-roledescription"),
          value: await slider.getAttribute("aria-valuenow"),
          maximum: await slider.getAttribute("aria-valuemax"),
          text: await slider.getAttribute("aria-valuetext"),
        });
      }
      panels.push({ text: (await panel.innerText()).slice(0, 300), sliders });
    }
    throw new Error(
      `ChatGPT model selected state could not be verified: ${modelLabel}. Panels: ${JSON.stringify(panels)}`,
    );
  }
  await page.keyboard.press("Escape");
  return selected;
}

async function findPromptInput(page: Page) {
  const textbox = page.locator("#prompt-textarea:visible").first();
  try {
    await textbox.waitFor({ state: "visible", timeout: 10_000 });
    return textbox;
  } catch {
    const fallback = page
      .locator(
        'form textarea:visible, form [contenteditable="true"]:visible, main [role="textbox"][contenteditable="true"]:visible',
      )
      .first();
    await fallback.waitFor({ state: "visible", timeout: 10_000 });
    return fallback;
  }
}

async function waitForPromptSubmission(
  page: Page,
  prompt: string,
  previousUserCount: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const messages = await page.locator('[data-message-author-role="user"]').allInnerTexts();
    if (messages.slice(previousUserCount).some((text) => text.trim() === prompt.trim()))
      return true;
    await page.waitForTimeout(250);
  }
  return false;
}

async function readPromptInput(input: Locator): Promise<string> {
  return (await input.getAttribute("contenteditable")) === "true"
    ? input.innerText()
    : input.inputValue();
}

async function sendPrompt(page: Page, prompt: string): Promise<number> {
  const previousUserCount = await page.locator('[data-message-author-role="user"]').count();
  const previousAssistantCount = await page
    .locator('[data-message-author-role="assistant"]')
    .count();
  const input = await findPromptInput(page);
  await input.fill(prompt);

  const sendButton = page.locator('button[data-testid="send-button"]:visible').first();
  const localizedButton = page
    .getByRole("button", {
      name: /^(?:发送(?:消息|提示)?|傳送(?:訊息|提示)?|提交|プロンプトを送信する|送信|Send prompt|Send message|Send)$/iu,
    })
    .last();
  try {
    if (await sendButton.count()) await sendButton.click({ timeout: 5_000 });
    else if (await localizedButton.count()) await localizedButton.click({ timeout: 5_000 });
  } catch {
    // A click can race a UI update. Confirm submission before considering another action.
  }
  if (await waitForPromptSubmission(page, prompt, previousUserCount, 5_000)) {
    return previousAssistantCount;
  }
  // Retry only if the exact draft remains. Do not duplicate an accepted message.
  if ((await readPromptInput(input)).trim() === prompt.trim()) {
    await input.press("Enter");
  }
  if (!(await waitForPromptSubmission(page, prompt, previousUserCount, 25_000))) {
    throw new Error("ChatGPT prompt submission was not confirmed; no assistant response accepted");
  }
  return previousAssistantCount;
}

function looksLikeLoginGate(pageText: string): boolean {
  return (
    /Log in|Sign up|ログイン|サインアップ|ログアウト/u.test(pageText) &&
    !/ChatGPT とチャットする|質問してみましょう|Message ChatGPT|Ask anything/u.test(pageText)
  );
}

function isStillGenerating(pageText: string): boolean {
  return /Pro が思考中です|停止|Stop generating|Stop streaming|Generating|思考中|正在思考|Thinking/iu.test(
    pageText,
  );
}

async function waitForProResponse(
  page: Page,
  input: RunProPromptInput,
  previousAssistantCount: number,
): Promise<{ pageText: string; responseText: string }> {
  const timeoutSec = input.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const pollIntervalSec = input.pollIntervalSec ?? DEFAULT_POLL_INTERVAL_SEC;
  const deadline = Date.now() + timeoutSec * 1000;
  const stableWindowMs = Math.max(8_000, pollIntervalSec * 2 * 1000);
  let lastPageText = "";
  let stableSince = 0;

  while (Date.now() < deadline) {
    await page.waitForTimeout(pollIntervalSec * 1000);
    const messages = page.locator('[data-message-author-role="assistant"]');
    if ((await messages.count()) <= previousAssistantCount) {
      stableSince = 0;
      continue;
    }
    const message = messages.last();
    const markdown = message.locator(".markdown");
    const hasMarkdown = (await markdown.count()) > 0;
    const responseText = hasMarkdown
      ? (await markdown.allInnerTexts()).join("\n\n").trim()
      : (await message.innerText()).trim();
    const stopButton = page.getByRole("button", {
      name: /^(?:停止(?:生成|回答|响应|流式传输)?|停止產生|Stop(?: generating| streaming)?|生成を停止)$/iu,
    });
    const generating =
      (await page.locator('[data-testid="stop-button"]:visible').count()) > 0 ||
      (await stopButton.isVisible()) ||
      (await message.getAttribute("data-is-streaming")) === "true" ||
      (!hasMarkdown &&
        isStillGenerating(responseText) &&
        /^(?:Pro が思考中です|思考中|正在思考|Thinking)[.…\s]*$/iu.test(responseText));
    if (responseText && !generating && responseText === lastPageText) {
      stableSince ||= Date.now();
      if (Date.now() - stableSince >= stableWindowMs) {
        return { pageText: await readPageText(page), responseText };
      }
    } else {
      stableSince = 0;
    }
    lastPageText = responseText;
  }

  throw new Error(
    `Timed out waiting for a completed ChatGPT Pro assistant response after ${timeoutSec}s`,
  );
}

async function fetchCdpVersion(port: number): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_000);
  try {
    const response = await fetch(`http://localhost:${port}/json/version`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForCdp(port: number, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await fetchCdpVersion(port)) {
      return;
    }
    await sleep(250);
  }
  throw new Error(`Chrome CDP did not become ready on port ${port}`);
}

async function waitForGoogleChromeExit(timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isGoogleChromeRunning()) {
      return;
    }
    await sleep(250);
  }
  throw new Error(
    "Google Chrome did not quit within the restart timeout. Close Google Chrome manually once, then rerun prepare_pro_browser or run_pro_prompt.",
  );
}

async function terminateGoogleChromeProcesses(): Promise<void> {
  for (const processInfo of googleChromeProcesses()) {
    try {
      process.kill(processInfo.pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }
  }
  await waitForGoogleChromeExit(15_000);
}

async function quitGoogleChromeForRestart(input: { forceTerminate: boolean }): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("allowChromeRestart currently supports macOS only");
  }
  if (!isGoogleChromeRunning()) {
    return;
  }
  try {
    await runAppleScript('tell application "Google Chrome" to quit', 15_000);
    await waitForGoogleChromeExit(20_000);
  } catch (error) {
    if (!input.forceTerminate) {
      throw error;
    }
    await terminateGoogleChromeProcesses();
  }
}

function launchChromeForCdp(input: {
  port: number;
  profileDirectory: string;
  userDataDir?: string;
}): void {
  const args = [
    "-na",
    "Google Chrome",
    "--args",
    `--remote-debugging-port=${input.port}`,
    `--profile-directory=${input.profileDirectory}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
  if (input.userDataDir) {
    args.splice(5, 0, `--user-data-dir=${input.userDataDir}`);
  }
  const child = spawn("open", args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function findRunningChromeCdpPort(input: {
  profileDirectory: string;
  userDataDir?: string;
}): number | undefined {
  const result = spawnSync("ps", ["axo", "command="], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0) {
    return undefined;
  }
  const escapedProfileDirectory = escapeRegex(input.profileDirectory);
  const escapedUserDataDir = input.userDataDir ? escapeRegex(input.userDataDir) : undefined;
  const linePattern = escapedUserDataDir
    ? new RegExp(
        `Google Chrome.*--remote-debugging-port=(\\d+).*--user-data-dir=${escapedUserDataDir}`,
      )
    : new RegExp(
        `Google Chrome.*--remote-debugging-port=(\\d+).*--profile-directory=${escapedProfileDirectory}`,
      );
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(linePattern);
    if (!match?.[1]) {
      continue;
    }
    const port = Number.parseInt(match[1], 10);
    if (Number.isInteger(port) && port > 0) {
      return port;
    }
  }
  return undefined;
}

async function closeCdpBrowser(browser: Browser): Promise<void> {
  try {
    const session = await browser.newBrowserCDPSession();
    await session.send("Browser.close");
  } catch {
    // If Browser.close is unavailable, fall back to closing the Playwright connection.
  }
  try {
    await browser.close();
  } catch {
    // Chrome may already be gone after Browser.close.
  }
}

async function disconnectCdpBrowser(browser: Browser): Promise<void> {
  try {
    await browser.close();
  } catch {
    // The browser may have been closed manually.
  }
}

async function connectPlaywrightChrome(input: {
  chatgptUrl?: string;
  cdpEndpoint?: string;
  chromeProfileDirectory?: string;
  allowChromeRestart?: boolean;
  forceChromeRestart?: boolean;
}): Promise<{
  browser: Browser;
  context: BrowserContext;
  page: Page;
  chromeProfilesRoot: string;
  chromeProfileDirectory: string;
  chromeUserDataDir?: string;
  systemChromeProfileMode: boolean;
  cdpPort?: number;
  reusedBrowser: boolean;
  externalEndpoint: boolean;
}> {
  const { chromium } = await import("playwright-core");
  const profileDirectory = chromeProfileDirectory(input.chromeProfileDirectory);
  const profilesRoot = chromeProfilesRoot();
  const userDataDir = chromeUserDataDir();
  const restartAllowed = allowChromeRestart(input.allowChromeRestart);
  const forceRestartAllowed = forceChromeRestart(input.forceChromeRestart);
  if (userDataDir) {
    ensurePrivateDirectory(userDataDir);
  }
  const externalEndpoint = configuredCdpEndpoint(input.cdpEndpoint);
  if (externalEndpoint) {
    const browser = await chromium.connectOverCDP(externalEndpoint);
    const context = browser.contexts()[0];
    if (!context) {
      throw new Error("External Chrome CDP connection did not expose a browser context");
    }
    const page = context.pages()[0] || (await context.newPage());
    page.setDefaultTimeout(30_000);
    await page.goto(input.chatgptUrl ?? DEFAULT_CHATGPT_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
    return {
      browser,
      context,
      page,
      chromeProfilesRoot: profilesRoot,
      chromeProfileDirectory: profileDirectory,
      chromeUserDataDir: userDataDir,
      systemChromeProfileMode: !userDataDir,
      reusedBrowser: true,
      externalEndpoint: true,
    };
  }
  const runningPort = findRunningChromeCdpPort({
    profileDirectory,
    userDataDir,
  });
  const configuredPort = process.env.MCP_PRO_CDP_PORT
    ? Number.parseInt(process.env.MCP_PRO_CDP_PORT, 10)
    : undefined;
  const cdpPort = runningPort ?? configuredPort ?? (await findFreeLocalPort());
  if (!Number.isInteger(cdpPort) || cdpPort <= 0) {
    throw new Error("MCP_PRO_CDP_PORT must be a positive integer");
  }
  if (!runningPort) {
    launchChromeForCdp({ port: cdpPort, profileDirectory, userDataDir });
  }
  try {
    await waitForCdp(cdpPort, 30_000);
  } catch (error) {
    if (!userDataDir && restartAllowed) {
      await quitGoogleChromeForRestart({ forceTerminate: forceRestartAllowed });
      launchChromeForCdp({ port: cdpPort, profileDirectory, userDataDir });
      await waitForCdp(cdpPort, 30_000);
    } else if (!userDataDir) {
      throw new Error(
        [
          error instanceof Error ? error.message : String(error),
          `Chrome profile mode uses --profile-directory=${profileDirectory}.`,
          "If normal Chrome is already running without remote debugging, call prepare_pro_browser/run_pro_prompt with allowChromeRestart: true, quit Chrome once yourself, or pass a localhost cdpEndpoint. If polite quit is blocked and closing Chrome is acceptable, also pass forceChromeRestart: true.",
        ].join(" "),
      );
    } else {
      throw error;
    }
  }
  const browser = await chromium.connectOverCDP(`http://localhost:${cdpPort}`);
  const context = browser.contexts()[0];
  if (!context) {
    throw new Error("Chrome CDP connection did not expose a browser context");
  }
  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(30_000);
  await page.goto(input.chatgptUrl ?? DEFAULT_CHATGPT_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
  return {
    browser,
    context,
    page,
    chromeProfilesRoot: profilesRoot,
    chromeProfileDirectory: profileDirectory,
    chromeUserDataDir: userDataDir,
    systemChromeProfileMode: !userDataDir,
    cdpPort,
    reusedBrowser: Boolean(runningPort),
    externalEndpoint: false,
  };
}

async function runPlaywrightChrome(input: RunProPromptInput): Promise<BrowserRunResult> {
  const started = Date.now();
  let browser: Browser | undefined;
  let externalEndpoint = false;
  let shouldKeepChromeOpen = false;
  const keepOpen =
    input.keepBrowserOpen === true || process.env.MCP_PRO_KEEP_BROWSER_OPEN === "true";
  try {
    const session = await connectPlaywrightChrome({
      chatgptUrl: input.chatgptUrl,
      cdpEndpoint: input.cdpEndpoint,
      chromeProfileDirectory: input.chromeProfileDirectory,
      allowChromeRestart: input.allowChromeRestart,
      forceChromeRestart: input.forceChromeRestart,
    });
    browser = session.browser;
    externalEndpoint = session.externalEndpoint;
    shouldKeepChromeOpen = keepOpen || externalEndpoint || session.systemChromeProfileMode;
    const page = session.page;
    const initialText = await readPageText(page);
    if (looksLikeLoginGate(initialText)) {
      const profileLocation = session.chromeUserDataDir ?? session.chromeProfilesRoot;
      const setup = keepOpen
        ? "The Chrome window has been left open. Log in once there, then rerun run_pro_prompt."
        : "Rerun run_pro_prompt with keepBrowserOpen: true, log in once in the opened Chrome window, then rerun the tool.";
      throw new Error(
        `ChatGPT login is required in Chrome profile ${session.chromeProfileDirectory} under ${profileLocation}. ${setup}`,
      );
    }
    const verifiedModelLabel = await selectModelLabel(page, modelLabel(input.modelLabel));
    const previousAssistantCount = await sendPrompt(page, input.prompt);
    const output = await waitForProResponse(page, input, previousAssistantCount);
    return {
      backend: "playwright-chrome",
      pageText: output.pageText,
      responseText: output.responseText,
      durationMs: Date.now() - started,
      verifiedModelLabel,
    };
  } finally {
    if (browser) {
      if (shouldKeepChromeOpen) {
        await disconnectCdpBrowser(browser);
      } else {
        await closeCdpBrowser(browser);
      }
    }
  }
}

async function runChromeAppleScript(input: RunProPromptInput): Promise<BrowserRunResult> {
  if (process.platform !== "darwin") {
    throw new Error("Chrome Pro automation currently requires macOS.");
  }
  const started = Date.now();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gptpro-"));
  const promptPath = path.join(tempDir, "prompt.txt");
  const outputPath = path.join(tempDir, "page.txt");
  fs.writeFileSync(promptPath, input.prompt, { encoding: "utf8", mode: 0o600 });
  const timeoutSec = input.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const script = chromeAppleScript({
    promptPath,
    outputPath,
    modelLabel: modelLabel(input.modelLabel),
    chatgptUrl: input.chatgptUrl ?? DEFAULT_CHATGPT_URL,
    timeoutSec,
    pollIntervalSec: input.pollIntervalSec ?? DEFAULT_POLL_INTERVAL_SEC,
  });
  await runAppleScript(script, (timeoutSec + 90) * 1000);
  const pageText = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
  const responseText = extractResponseText(pageText, input.prompt);
  return {
    backend: "chrome-applescript",
    pageText,
    responseText,
    durationMs: Date.now() - started,
  };
}

export async function prepareProBrowserTool(input: PrepareProBrowserInput = {}): Promise<{
  platform: string;
  mode: string;
  chromeProfilesRoot: string;
  chromeProfileDirectory: string;
  chromeUserDataDir?: string;
  systemChromeProfileMode: boolean;
  cdpPort?: number;
  reusedBrowser?: boolean;
  externalEndpoint?: boolean;
  chromeRestartAllowed: boolean;
  chromeForceRestartAllowed: boolean;
  pageUrl?: string;
  loginRequired: boolean;
  keptOpen: boolean;
  instructions: string[];
}> {
  const mode = proBrowserMode();
  const keepOpen = input.keepBrowserOpen !== false;
  const restartAllowed = allowChromeRestart(input.allowChromeRestart);
  const forceRestartAllowed = forceChromeRestart(input.forceChromeRestart);
  if (mode === "mock") {
    return {
      platform: process.platform,
      mode,
      chromeProfilesRoot: chromeProfilesRoot(),
      chromeProfileDirectory: chromeProfileDirectory(input.chromeProfileDirectory),
      chromeUserDataDir: chromeUserDataDir(),
      systemChromeProfileMode: useSystemChromeProfile(),
      chromeRestartAllowed: restartAllowed,
      chromeForceRestartAllowed: forceRestartAllowed,
      loginRequired: false,
      keptOpen: false,
      instructions: ["Mock mode is active; no browser login is required."],
    };
  }
  if (mode !== "playwright-chrome") {
    return {
      platform: process.platform,
      mode,
      chromeProfilesRoot: chromeProfilesRoot(),
      chromeProfileDirectory: chromeProfileDirectory(input.chromeProfileDirectory),
      chromeUserDataDir: chromeUserDataDir(),
      systemChromeProfileMode: useSystemChromeProfile(),
      chromeRestartAllowed: restartAllowed,
      chromeForceRestartAllowed: forceRestartAllowed,
      loginRequired: false,
      keptOpen: false,
      instructions: [
        "prepare_pro_browser is intended for playwright-chrome mode.",
        "Use pro_browser_status for chrome-applescript permissions.",
      ],
    };
  }

  let browser: Browser | undefined;
  let externalEndpoint = false;
  try {
    const session = await connectPlaywrightChrome({
      chatgptUrl: input.chatgptUrl,
      cdpEndpoint: input.cdpEndpoint,
      chromeProfileDirectory: input.chromeProfileDirectory,
      allowChromeRestart: input.allowChromeRestart,
      forceChromeRestart: input.forceChromeRestart,
    });
    browser = session.browser;
    externalEndpoint = session.externalEndpoint;
    const pageText = await readPageText(session.page);
    const loginRequired = looksLikeLoginGate(pageText);
    return {
      platform: process.platform,
      mode,
      chromeProfilesRoot: session.chromeProfilesRoot,
      chromeProfileDirectory: session.chromeProfileDirectory,
      chromeUserDataDir: session.chromeUserDataDir,
      systemChromeProfileMode: session.systemChromeProfileMode,
      cdpPort: session.cdpPort,
      reusedBrowser: session.reusedBrowser,
      externalEndpoint: session.externalEndpoint,
      chromeRestartAllowed: restartAllowed,
      chromeForceRestartAllowed: forceRestartAllowed,
      pageUrl: session.page.url(),
      loginRequired,
      keptOpen: keepOpen,
      instructions: loginRequired
        ? [
            "The codex-gptpro Chrome window is open.",
            "Log in to ChatGPT once in that window.",
            "After login completes, call run_pro_prompt again.",
          ]
        : ["ChatGPT appears to be logged in for the codex-gptpro Chrome profile."],
    };
  } finally {
    if (browser) {
      if (keepOpen || externalEndpoint) {
        await disconnectCdpBrowser(browser);
      } else {
        await closeCdpBrowser(browser);
      }
    }
  }
}

export async function proBrowserStatusTool(): Promise<{
  platform: string;
  mode: string;
  chromeProfilesRoot: string;
  chromeProfileDirectory: string;
  chromeUserDataDir?: string;
  systemChromeProfileMode: boolean;
  chromeRunning: boolean;
  matchingCdpPort?: number;
  playwrightChromeAvailable: boolean;
  chromeAppleScriptAvailable: boolean;
  systemEventsAllowed: boolean;
  notes: string[];
}> {
  const notes: string[] = [];
  const mode = proBrowserMode();
  const profileDirectory = chromeProfileDirectory();
  const userDataDir = chromeUserDataDir();
  const chromeRunning = isGoogleChromeRunning();
  const matchingCdpPort = findRunningChromeCdpPort({
    profileDirectory,
    userDataDir,
  });
  let playwrightChromeAvailable = false;
  let chromeAppleScriptAvailable = false;
  let systemEventsAllowed = false;
  try {
    await import("playwright-core");
    playwrightChromeAvailable = true;
  } catch (error) {
    notes.push(error instanceof Error ? error.message : String(error));
  }
  if (process.platform !== "darwin") {
    if (mode === "chrome-applescript") {
      notes.push("chrome-applescript mode supports macOS only.");
    }
    return {
      platform: process.platform,
      mode,
      chromeProfilesRoot: chromeProfilesRoot(),
      chromeProfileDirectory: profileDirectory,
      chromeUserDataDir: userDataDir,
      systemChromeProfileMode: !userDataDir,
      chromeRunning,
      matchingCdpPort,
      playwrightChromeAvailable,
      chromeAppleScriptAvailable,
      systemEventsAllowed,
      notes,
    };
  }
  if (mode === "playwright-chrome" && chromeRunning && !matchingCdpPort && !userDataDir) {
    notes.push(
      "Google Chrome is running without the matching CDP port. Use allowChromeRestart: true, quit Chrome once before prepare_pro_browser, or pass a localhost cdpEndpoint. If polite quit is blocked and closing Chrome is acceptable, also pass forceChromeRestart: true.",
    );
  }
  if (mode === "chrome-applescript") {
    try {
      await runAppleScript('tell application "Google Chrome" to get name', 5_000);
      chromeAppleScriptAvailable = true;
    } catch (error) {
      notes.push(error instanceof Error ? error.message : String(error));
    }
    try {
      await runAppleScript(
        'tell application "System Events" to tell process "Google Chrome" to count windows',
        5_000,
      );
      systemEventsAllowed = true;
    } catch (error) {
      notes.push(error instanceof Error ? error.message : String(error));
    }
    if (!systemEventsAllowed) {
      notes.push(
        "Grant Accessibility/Automation permissions before using run_pro_prompt with the real Chrome backend.",
      );
    }
  }
  return {
    platform: process.platform,
    mode,
    chromeProfilesRoot: chromeProfilesRoot(),
    chromeProfileDirectory: profileDirectory,
    chromeUserDataDir: userDataDir,
    systemChromeProfileMode: !userDataDir,
    chromeRunning,
    matchingCdpPort,
    playwrightChromeAvailable,
    chromeAppleScriptAvailable,
    systemEventsAllowed,
    notes,
  };
}

export async function runProPromptTool(
  config: AppConfig,
  input: RunProPromptInput,
): Promise<{
  runId: string;
  backend: BrowserRunResult["backend"];
  modelLabel: string;
  durationMs: number;
  responseText: string;
  responseBytes: number;
  responseTruncated: boolean;
  verifiedModelLabel?: string;
  requestPath?: string;
  responsePath?: string;
}> {
  if (!input.confirmSendToChatGpt) {
    throw new Error(
      "confirmSendToChatGpt must be true because this tool sends prompt content to ChatGPT Web.",
    );
  }
  const runId = `WEBGPT-${timestampId()}-${Math.random().toString(36).slice(2, 8)}`;
  const mode = proBrowserMode();
  const result =
    mode === "mock" || process.env.MCP_PRO_MOCK_RESPONSE
      ? await runMockBrowser(input)
      : mode === "chrome-applescript"
        ? await runChromeAppleScript(input)
        : await runPlaywrightChrome(input);
  const response = truncateText(
    result.responseText,
    input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
  );
  const artifactPaths =
    input.save === false
      ? undefined
      : writeArtifacts(config, input, result, {
          runId,
          modelLabel: modelLabel(input.modelLabel),
          response: {
            text: response.text,
            truncated: response.truncated,
          },
        });

  return {
    runId,
    backend: result.backend,
    modelLabel: modelLabel(input.modelLabel),
    durationMs: result.durationMs,
    responseText: response.text,
    responseBytes: response.bytes,
    responseTruncated: response.truncated,
    ...(result.verifiedModelLabel ? { verifiedModelLabel: result.verifiedModelLabel } : {}),
    requestPath: artifactPaths?.requestPath,
    responsePath: artifactPaths?.responsePath,
  };
}
