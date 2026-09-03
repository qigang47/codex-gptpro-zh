import { afterEach, describe, expect, it, vi } from "vitest";
import { runProPromptTool } from "../tools/proTools.js";
import { makeConfig } from "./testUtils.js";

const connectOverCDP = vi.hoisted(() => vi.fn());
vi.mock("playwright-core", () => ({ chromium: { connectOverCDP } }));

type Node = {
  text: () => string;
  attributes?: Record<string, string>;
  click?: () => void;
  fill?: (text: string) => void;
  press?: (key: string) => void;
  children?: () => Node[];
  role?: string;
};

class FixtureLocator {
  constructor(private nodes: () => Node[]) {}
  first() {
    return new FixtureLocator(() => this.nodes().slice(0, 1));
  }
  last() {
    return new FixtureLocator(() => this.nodes().slice(-1));
  }
  async all() {
    return this.nodes().map((node) => new FixtureLocator(() => [node]));
  }
  async count() {
    return this.nodes().length;
  }
  async isVisible() {
    return this.nodes().length > 0;
  }
  async innerText() {
    return this.nodes()[0]?.text() ?? "";
  }
  async inputValue() {
    return this.innerText();
  }
  filter({ hasText }: { hasText: RegExp }) {
    return new FixtureLocator(() => this.nodes().filter((node) => hasText.test(node.text())));
  }
  async allInnerTexts() {
    return this.nodes().map((node) => node.text());
  }
  async getAttribute(name: string) {
    return this.nodes()[0]?.attributes?.[name] ?? null;
  }
  async waitFor() {
    if (!this.nodes().length) throw new Error("not visible");
  }
  async click() {
    await this.waitFor();
    this.nodes()[0].click?.();
  }
  async fill(text: string) {
    this.nodes()[0].fill?.(text);
  }
  async press(key: string) {
    this.nodes()[0].press?.(key);
  }
  locator() {
    return new FixtureLocator(() => this.nodes().flatMap((node) => node.children?.() ?? []));
  }
  getByRole(role: string) {
    return new FixtureLocator(() =>
      this.nodes()
        .flatMap((node) => node.children?.() ?? [])
        .filter((node) => node.role === role),
    );
  }
  getByText(pattern: RegExp) {
    return new FixtureLocator(() =>
      this.nodes()
        .flatMap((node) => node.children?.() ?? [])
        .filter((node) => pattern.test(node.text())),
    );
  }
}

function fixture(
  options: {
    noModelControl?: boolean;
    collapsedEffort?: boolean;
    slider?: boolean;
    localizedSend?: boolean;
    clickDoesNothing?: boolean;
    neverSubmit?: boolean;
    noResponse?: boolean;
    noMarkdown?: boolean;
    streaming?: boolean;
    oldResponse?: string;
    finalResponse?: string;
    delayedSubmission?: boolean;
  } = {},
) {
  const users: string[] = options.oldResponse ? ["old question"] : [];
  const answers: string[] = options.oldResponse ? [options.oldResponse] : [];
  const pressed: string[] = [];
  let selected = options.slider ? "Thinking" : "Pro";
  let popupOpen = false;
  let draft = "";
  let submissionAt = 0;
  let submitted = false;
  let clicks = 0;
  const submit = () => {
    if (options.neverSubmit || submitted) return;
    submitted = true;
    users.push(draft || "只回复 OK");
    draft = "";
    if (!options.noResponse) answers.push(options.finalResponse ?? "OK");
  };
  const input: Node = {
    text: () => draft,
    attributes: { contenteditable: "true" },
    fill: (text) => {
      draft = text;
    },
    press: (key) => {
      pressed.push(key);
      if (key === "Enter") submit();
    },
  };
  const model: Node = {
    text: () => selected,
    click: () => {
      popupOpen = true;
    },
  };
  const thinking: Node = {
    text: () => "思考强度",
    click: () => {
      popupOpen = true;
    },
  };
  const option: Node = {
    text: () => "Pro",
    click: () => {
      selected = "Pro";
    },
  };
  const slider: Node = {
    text: () => "",
    role: "slider",
    attributes: { "aria-valuenow": "100", "aria-valuemax": "100" },
  };
  const popup: Node = {
    text: () => "Pro",
    children: () => (options.slider ? [option, slider] : [option]),
  };
  const send: Node = {
    text: () => "发送",
    click: () => {
      clicks++;
      if (options.clickDoesNothing) return;
      if (options.delayedSubmission) {
        draft = "";
        submissionAt = Date.now() + 7_000;
      } else submit();
    },
  };
  const stop: Node = { text: () => "停止生成" };
  const page = {
    setDefaultTimeout: vi.fn(),
    goto: vi.fn(),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    keyboard: {
      press: vi.fn(async () => {
        popupOpen = false;
      }),
    },
    waitForTimeout: async (ms: number) => {
      vi.setSystemTime(Date.now() + ms);
      if (submissionAt && Date.now() >= submissionAt) submit();
    },
    locator: (selector: string) =>
      new FixtureLocator(() => {
        if (selector === "body")
          return [{ text: () => `Pro subscription\n只回复 OK\n首页导航\n${draft}` }];
        if (selector.includes("model-switcher-dropdown-button"))
          return options.noModelControl || options.slider || options.collapsedEffort ? [] : [model];
        if (selector === 'button[aria-haspopup="menu"]:visible')
          return options.collapsedEffort ? [model] : [];
        if (selector.includes("aria-checked"))
          return popupOpen && selected === "Pro" && !options.slider ? [option] : [];
        if (selector.includes('[role="menu"]')) return popupOpen ? [popup] : [];
        if (selector.includes("prompt-textarea") || selector.includes("form textarea"))
          return [input];
        if (selector.includes('data-message-author-role="user"'))
          return users.map((text) => ({ text: () => text }));
        if (selector.includes('data-message-author-role="assistant"'))
          return answers.map((text) => ({
            text: () => text,
            children: () => (options.noMarkdown ? [] : [{ text: () => text }]),
            attributes: { "data-is-streaming": String(Boolean(options.streaming)) },
          }));
        if (selector.includes("send-button")) return options.localizedSend ? [] : [send];
        if (selector.includes("stop-button")) return options.streaming ? [stop] : [];
        if (selector === 'button:visible, [role="button"]:visible') return [];
        throw new Error(`Unexpected selector: ${selector}`);
      }),
    getByRole: (_role: string, { name }: { name: RegExp }) =>
      new FixtureLocator(() => {
        const controls = [
          send,
          ...(options.slider ? [thinking] : []),
          ...(options.streaming ? [stop] : []),
        ];
        return controls.filter((node) => name.test(node.text()));
      }),
  };
  connectOverCDP.mockResolvedValue({ contexts: () => [{ pages: () => [page] }], close: vi.fn() });
  return { pressed, clicks: () => clicks, users, answers, page };
}

async function run() {
  const config = makeConfig();
  vi.stubEnv("MCP_PRO_BROWSER_MODE", "playwright-chrome");
  vi.stubEnv("MCP_PRO_MOCK_RESPONSE", "");
  vi.stubEnv("MCP_PRO_CHROME_AUTOMATION_USER_DATA_DIR", config.repoRoot);
  return runProPromptTool(config, {
    prompt: "只回复 OK",
    modelLabel: "Pro",
    confirmSendToChatGpt: true,
    cdpEndpoint: "http://127.0.0.1:19222",
    timeoutSec: 30,
    pollIntervalSec: 2,
    keepBrowserOpen: true,
    save: false,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("ChatGPT browser regression checks (no real browser or network)", () => {
  it("rejects a Pro subscription badge without a selected model control", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const state = fixture({ noModelControl: true });
    await expect(run()).rejects.toThrow("selection not verified");
    expect(state.clicks()).toBe(0);
  });

  it("verifies the Chinese effort slider and returns only the assistant message", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    fixture({ slider: true, localizedSend: true });
    const result = await run();
    expect(result.responseText).toBe("OK");
    expect(result.verifiedModelLabel).toBe("Pro");
    expect(result.backend).toBe("playwright-chrome");
  });

  it("uses Enter if a click leaves the exact draft unsubmitted", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const state = fixture({ clickDoesNothing: true });
    expect((await run()).responseText).toBe("OK");
    expect(state.pressed).toEqual(["Enter"]);
    expect(state.users).toEqual(["只回复 OK"]);
  });

  it("recognizes the selected Pro effort menu button from the live Chinese interface", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    fixture({ collapsedEffort: true });
    expect((await run()).verifiedModelLabel).toBe("Pro");
  });

  it("does not resend a cleared draft while submission is delayed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const state = fixture({ delayedSubmission: true });
    expect((await run()).responseText).toBe("OK");
    expect(state.pressed).toEqual([]);
    expect(state.clicks()).toBe(1);
  });

  it("does not accept draft text or navigation as a submitted message", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    fixture({ neverSubmit: true });
    await expect(run()).rejects.toThrow("submission was not confirmed");
  });

  it("does not reuse an old assistant answer when no new answer arrives", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    fixture({ oldResponse: "old answer", noResponse: true });
    await expect(run()).rejects.toThrow("completed ChatGPT Pro assistant response");
  });

  it("fails on a still-streaming partial response instead of returning it on timeout", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    fixture({ streaming: true, finalResponse: "partial answer" });
    await expect(run()).rejects.toThrow("completed ChatGPT Pro assistant response");
  });

  it("does not confuse quoted stop instructions inside a final answer with generation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    fixture({ finalResponse: "Use Stop generating to cancel a request." });
    expect((await run()).responseText).toBe("Use Stop generating to cancel a request.");
  });

  it("does not mistake a Chinese thinking placeholder for a final assistant answer", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    fixture({ noMarkdown: true, finalResponse: "正在思考" });
    await expect(run()).rejects.toThrow("completed ChatGPT Pro assistant response");
  });
});
