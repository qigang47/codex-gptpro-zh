import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withAudit } from "../core/audit.js";
import { type AppConfig, validatePublicPin } from "../core/config.js";
import { listProjects, projectIdShape, withProject } from "../core/projects.js";
import { gitDiff } from "../tools/gitTools.js";
import { grepRepo, readFile, repoTree } from "../tools/repoTools.js";
import { readResultInputSchema, readResultTool } from "../tools/resultTools.js";
import { writeReviewInputSchema, writeReviewTool } from "../tools/reviewTools.js";
import {
  createTaskInputSchema,
  createTaskTool,
  listTasksInputSchema,
  listTasksTool,
  readTaskInputSchema,
  readTaskTool,
} from "../tools/taskTools.js";

export const SERVER_INSTRUCTIONS =
  "ChatGPT is planner/reviewer. Codex is executor. Use task files under .ai/tasks. Do not use this MCP as a shell. Use small, reviewable tasks. Never modify unrelated files.\n\n" +
  "ChatGPT should inspect the repository, create small implementation tasks, read Codex results, inspect bounded diffs, and write reviews. Codex implements through the separate bearer-protected endpoint.\n\n" +
  "When a Codex user says to use codex_gptpro, Codex should automatically register the current workspace before any project-scoped tool call: use the current workspace absolute path as repoRoot, derive projectId from the repository directory name, use the same value as name unless a clearer name is known, and setDefault true. Do this without asking the user to provide registration details. Calling register_project repeatedly is safe; it returns alreadyRegistered for existing repositories.\n\n" +
  "The Codex endpoint exposes run_pro_prompt as a core tool: it sends a bounded prompt from the MCP server to ChatGPT Web Pro extension in Chrome, waits for completion, saves the answer under .ai/pro-outputs, and returns it to Codex. Use pro_browser_status first when diagnosing Chrome permissions. Do not use arbitrary shell or patch tools through this MCP.";

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

const pinShape = {
  pin: z.string().min(1).optional(),
};

const repoTreeInputSchema = {
  ...pinShape,
  ...projectIdShape,
  path: z.string().optional(),
  depth: z.number().int().min(0).max(8).optional(),
  maxEntries: z.number().int().positive().max(1_000).optional(),
};

const readFileInputSchema = {
  ...pinShape,
  ...projectIdShape,
  path: z.string().min(1),
  maxBytes: z.number().int().positive().optional(),
};

const grepRepoInputSchema = {
  ...pinShape,
  ...projectIdShape,
  query: z.string().min(1),
  glob: z.string().optional(),
  maxResults: z.number().int().positive().optional(),
};

const gitDiffInputSchema = {
  ...pinShape,
  ...projectIdShape,
  base: z.string().optional(),
  maxBytes: z.number().int().positive().optional(),
};

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const writeWorkbenchAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

function withoutPin<T extends { pin?: string }>(input: T): Omit<T, "pin"> {
  const { pin: _pin, ...rest } = input;
  return rest;
}

async function publicTool<T extends { pin?: string }>(
  config: AppConfig,
  tool: string,
  input: T,
  run: (inputWithoutPin: Omit<T, "pin">) => unknown | Promise<unknown>,
): Promise<ToolResult> {
  return toToolResult(
    await withAudit(config, "chatgpt", tool, async () => {
      validatePublicPin(config, input.pin ?? "");
      return run(withoutPin(input));
    }),
  );
}

export function createChatGptServer(config: AppConfig): McpServer {
  const server = new McpServer(
    {
      name: "codex-gptpro-chatgpt",
      version: "0.1.0",
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  server.registerTool(
    "list_projects",
    {
      description: "List configured project IDs available through this MCP server.",
      inputSchema: pinShape,
      annotations: readOnlyAnnotations,
    },
    async (input) => publicTool(config, "list_projects", input, () => listProjects(config)),
  );

  server.registerTool(
    "repo_tree",
    {
      description: "Return a compact, policy-filtered tree under the registered repository.",
      inputSchema: repoTreeInputSchema,
      annotations: readOnlyAnnotations,
    },
    async (input) =>
      publicTool(config, "repo_tree", input, (rest) => repoTree(withProject(config, rest), rest)),
  );

  server.registerTool(
    "read_file",
    {
      description:
        "Read a bounded text file under the registered repository, honoring denied paths.",
      inputSchema: readFileInputSchema,
      annotations: readOnlyAnnotations,
    },
    async (input) =>
      publicTool(config, "read_file", input, (rest) => readFile(withProject(config, rest), rest)),
  );

  server.registerTool(
    "grep_repo",
    {
      description: "Search repository text safely using rg when available.",
      inputSchema: grepRepoInputSchema,
      annotations: readOnlyAnnotations,
    },
    async (input) =>
      publicTool(config, "grep_repo", input, (rest) => grepRepo(withProject(config, rest), rest)),
  );

  server.registerTool(
    "git_diff",
    {
      description: "Return changed files, stat, and a bounded git diff with denied paths redacted.",
      inputSchema: gitDiffInputSchema,
      annotations: readOnlyAnnotations,
    },
    async (input) =>
      publicTool(config, "git_diff", input, (rest) => gitDiff(withProject(config, rest), rest)),
  );

  server.registerTool(
    "create_task",
    {
      description: "Create a small implementation task under .ai/tasks.",
      inputSchema: { ...pinShape, ...projectIdShape, ...createTaskInputSchema },
      annotations: writeWorkbenchAnnotations,
    },
    async (input) =>
      publicTool(config, "create_task", input, (rest) =>
        createTaskTool(withProject(config, rest), rest),
      ),
  );

  server.registerTool(
    "list_tasks",
    {
      description: "List markdown task summaries.",
      inputSchema: { ...pinShape, ...projectIdShape, ...listTasksInputSchema },
      annotations: readOnlyAnnotations,
    },
    async (input) =>
      publicTool(config, "list_tasks", input, (rest) =>
        listTasksTool(withProject(config, rest), rest),
      ),
  );

  server.registerTool(
    "read_task",
    {
      description: "Read one task markdown file.",
      inputSchema: { ...pinShape, ...projectIdShape, ...readTaskInputSchema },
      annotations: readOnlyAnnotations,
    },
    async (input) =>
      publicTool(config, "read_task", input, (rest) =>
        readTaskTool(withProject(config, rest), rest),
      ),
  );

  server.registerTool(
    "read_result",
    {
      description: "Read Codex result markdown for a task if present.",
      inputSchema: { ...pinShape, ...projectIdShape, ...readResultInputSchema },
      annotations: readOnlyAnnotations,
    },
    async (input) =>
      publicTool(config, "read_result", input, (rest) =>
        readResultTool(withProject(config, rest), rest),
      ),
  );

  server.registerTool(
    "write_review",
    {
      description: "Write a ChatGPT review under .ai/reviews without modifying source code.",
      inputSchema: { ...pinShape, ...projectIdShape, ...writeReviewInputSchema },
      annotations: writeWorkbenchAnnotations,
    },
    async (input) =>
      publicTool(config, "write_review", input, (rest) =>
        writeReviewTool(withProject(config, rest), rest),
      ),
  );

  return server;
}
