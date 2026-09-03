import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withAudit } from "../core/audit.js";
import type { AppConfig } from "../core/config.js";
import {
  listProjects,
  projectIdShape,
  registerProject,
  registerProjectInputSchema,
  withProject,
} from "../core/projects.js";
import { runCheckInputSchema, runCheckTool } from "../tools/checkTools.js";
import { gitDiff } from "../tools/gitTools.js";
import {
  prepareProBrowserInputSchema,
  prepareProBrowserTool,
  proBrowserStatusInputSchema,
  proBrowserStatusTool,
  runProPromptInputSchema,
  runProPromptTool,
} from "../tools/proTools.js";
import { grepRepo, readFile, repoTree } from "../tools/repoTools.js";
import {
  readResultInputSchema,
  readResultTool,
  writeResultInputSchema,
  writeResultTool,
} from "../tools/resultTools.js";
import {
  claimTaskInputSchema,
  claimTaskTool,
  listTasksInputSchema,
  listTasksTool,
  readTaskInputSchema,
  readTaskTool,
} from "../tools/taskTools.js";
import { SERVER_INSTRUCTIONS } from "./createChatGptServer.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
};

function toToolResult(value: unknown): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

const repoTreeInputSchema = {
  ...projectIdShape,
  path: z.string().optional(),
  depth: z.number().int().min(0).max(8).optional(),
  maxEntries: z.number().int().positive().max(1_000).optional(),
};

const readFileInputSchema = {
  ...projectIdShape,
  path: z.string().min(1),
  maxBytes: z.number().int().positive().optional(),
};

const grepRepoInputSchema = {
  ...projectIdShape,
  query: z.string().min(1),
  glob: z.string().optional(),
  maxResults: z.number().int().positive().optional(),
};

const gitDiffInputSchema = {
  ...projectIdShape,
  base: z.string().optional(),
  maxBytes: z.number().int().positive().optional(),
};

async function codexTool(
  config: AppConfig,
  tool: string,
  run: () => unknown | Promise<unknown>,
): Promise<ToolResult> {
  return toToolResult(await withAudit(config, "codex", tool, async () => run()));
}

export function createCodexServer(config: AppConfig): McpServer {
  const server = new McpServer(
    {
      name: "codex-gptpro-codex",
      version: "0.1.0",
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  server.registerTool(
    "register_project",
    {
      description:
        "Register a local repository in projects.local.json so future calls can use its projectId.",
      inputSchema: registerProjectInputSchema,
    },
    async (input) => codexTool(config, "register_project", () => registerProject(config, input)),
  );

  server.registerTool(
    "list_projects",
    {
      description: "List configured project IDs available through this MCP server.",
      inputSchema: {},
    },
    async () => codexTool(config, "list_projects", () => listProjects(config)),
  );

  server.registerTool(
    "pro_browser_status",
    {
      description:
        "Check whether the MCP server can control Chrome for ChatGPT Web Pro extension automation.",
      inputSchema: proBrowserStatusInputSchema,
    },
    async () => codexTool(config, "pro_browser_status", () => proBrowserStatusTool()),
  );

  server.registerTool(
    "prepare_pro_browser",
    {
      description:
        "Open the normal Google Chrome profile directory for codex-gptpro to ChatGPT without sending a prompt, so the user can complete first-run login before run_pro_prompt.",
      inputSchema: prepareProBrowserInputSchema,
    },
    async (input) => codexTool(config, "prepare_pro_browser", () => prepareProBrowserTool(input)),
  );

  server.registerTool(
    "run_pro_prompt",
    {
      description:
        "Send a prompt from this MCP server to ChatGPT Web Pro extension in Chrome, wait for the answer, save it under .ai/pro-outputs, and return the response.",
      inputSchema: { ...projectIdShape, ...runProPromptInputSchema },
    },
    async (input) =>
      codexTool(config, "run_pro_prompt", () =>
        runProPromptTool(withProject(config, input), input),
      ),
  );

  server.registerTool(
    "repo_tree",
    {
      description: "Return a compact, policy-filtered tree under the registered repository.",
      inputSchema: repoTreeInputSchema,
    },
    async (input) =>
      codexTool(config, "repo_tree", () => repoTree(withProject(config, input), input)),
  );

  server.registerTool(
    "read_file",
    {
      description:
        "Read a bounded text file under the registered repository, honoring denied paths.",
      inputSchema: readFileInputSchema,
    },
    async (input) =>
      codexTool(config, "read_file", () => readFile(withProject(config, input), input)),
  );

  server.registerTool(
    "grep_repo",
    {
      description: "Search repository text safely using rg when available.",
      inputSchema: grepRepoInputSchema,
    },
    async (input) =>
      codexTool(config, "grep_repo", () => grepRepo(withProject(config, input), input)),
  );

  server.registerTool(
    "git_diff",
    {
      description: "Return changed files, stat, and a bounded git diff with denied paths redacted.",
      inputSchema: gitDiffInputSchema,
    },
    async (input) =>
      codexTool(config, "git_diff", () => gitDiff(withProject(config, input), input)),
  );

  server.registerTool(
    "list_tasks",
    {
      description: "List markdown task summaries.",
      inputSchema: { ...projectIdShape, ...listTasksInputSchema },
    },
    async (input) =>
      codexTool(config, "list_tasks", () => listTasksTool(withProject(config, input), input)),
  );

  server.registerTool(
    "read_task",
    {
      description: "Read one task markdown file.",
      inputSchema: { ...projectIdShape, ...readTaskInputSchema },
    },
    async (input) =>
      codexTool(config, "read_task", () => readTaskTool(withProject(config, input), input)),
  );

  server.registerTool(
    "claim_task",
    {
      description: "Claim an open task for Codex.",
      inputSchema: { ...projectIdShape, ...claimTaskInputSchema },
    },
    async (input) =>
      codexTool(config, "claim_task", () => claimTaskTool(withProject(config, input), input)),
  );

  server.registerTool(
    "write_result",
    {
      description: "Write a Codex result report and mark the task done.",
      inputSchema: { ...projectIdShape, ...writeResultInputSchema },
    },
    async (input) =>
      codexTool(config, "write_result", () => writeResultTool(withProject(config, input), input)),
  );

  server.registerTool(
    "read_result",
    {
      description: "Read Codex result markdown for a task if present.",
      inputSchema: { ...projectIdShape, ...readResultInputSchema },
    },
    async (input) =>
      codexTool(config, "read_result", () => readResultTool(withProject(config, input), input)),
  );

  server.registerTool(
    "run_check",
    {
      description: "Run an allowlisted package.json script: typecheck, lint, test, or build.",
      inputSchema: { ...projectIdShape, ...runCheckInputSchema },
    },
    async (input) =>
      codexTool(config, "run_check", () => runCheckTool(withProject(config, input), input)),
  );

  return server;
}
