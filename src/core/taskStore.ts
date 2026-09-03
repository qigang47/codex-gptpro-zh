import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { escapeMarkdownTableCell, slugify } from "./sanitize.js";

export const taskStatusSchema = z.enum(["open", "claimed", "done", "reviewed"]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const prioritySchema = z.enum(["low", "normal", "high"]);
export type Priority = z.infer<typeof prioritySchema>;

export type CreateTaskInput = {
  title: string;
  objective: string;
  context?: string;
  relevantFiles?: string[];
  constraints?: string[];
  acceptanceCriteria: string[];
  verificationCommands?: string[];
  priority?: Priority;
};

export type TaskSummary = {
  id: string;
  title: string;
  status: TaskStatus;
  priority: Priority;
  createdBy: string;
  createdAt: string;
  claimedBy?: string;
  completedAt?: string;
  path: string;
};

type Frontmatter = Record<string, string>;

function formatTimestamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    "-",
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join("");
}

function validateTaskId(taskId: string): void {
  if (!/^TASK-\d{8}-\d{6}-[a-z0-9-]+$/.test(taskId)) {
    throw new Error("Invalid taskId");
  }
}

function taskPath(repoRoot: string, taskId: string): string {
  validateTaskId(taskId);
  return path.join(repoRoot, ".ai/tasks", `${taskId}.md`);
}

function resultPath(repoRoot: string, taskId: string): string {
  validateTaskId(taskId);
  return path.join(repoRoot, ".ai/results", `${taskId}-result.md`);
}

function reviewPath(repoRoot: string, taskId: string): string {
  validateTaskId(taskId);
  return path.join(repoRoot, ".ai/reviews", `${taskId}-review.md`);
}

function createUniqueTaskId(repoRoot: string, title: string): string {
  const timestamp = formatTimestamp();
  const slug = slugify(title);
  let taskId = `TASK-${timestamp}-${slug}`;
  let suffix = 2;
  while (fs.existsSync(taskPath(repoRoot, taskId))) {
    taskId = `TASK-${timestamp}-${slug}-${suffix}`;
    suffix += 1;
  }
  return taskId;
}

function renderList(items?: string[]): string {
  if (!items || items.length === 0) {
    return "- None";
  }
  return items.map((item) => `- ${item}`).join("\n");
}

function renderCommandBlock(commands?: string[]): string {
  if (!commands || commands.length === 0) {
    return "```bash\n# No verification commands supplied.\n```";
  }
  return `\`\`\`bash\n${commands.join("\n")}\n\`\`\``;
}

function serializeFrontmatter(frontmatter: Frontmatter): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    lines.push(`${key}: ${value}`);
  }
  lines.push("---");
  return lines.join("\n");
}

function parseFrontmatter(markdown: string): { frontmatter: Frontmatter; body: string } {
  if (!markdown.startsWith("---\n")) {
    throw new Error("Task markdown is missing frontmatter");
  }
  const end = markdown.indexOf("\n---", 4);
  if (end === -1) {
    throw new Error("Task markdown has invalid frontmatter");
  }
  const raw = markdown.slice(4, end).trim();
  const frontmatter: Frontmatter = {};
  for (const line of raw.split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index === -1) {
      continue;
    }
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    frontmatter[key] = value;
  }
  return { frontmatter, body: markdown.slice(end + "\n---".length) };
}

function frontmatterToSummary(
  repoRoot: string,
  absolutePath: string,
  markdown: string,
): TaskSummary {
  const { frontmatter } = parseFrontmatter(markdown);
  return {
    id: frontmatter.id ?? path.basename(absolutePath, ".md"),
    title: frontmatter.title ?? "(untitled)",
    status: taskStatusSchema.catch("open").parse(frontmatter.status),
    priority: prioritySchema.catch("normal").parse(frontmatter.priority),
    createdBy: frontmatter.created_by ?? "",
    createdAt: frontmatter.created_at ?? "",
    claimedBy: frontmatter.claimed_by || undefined,
    completedAt: frontmatter.completed_at || undefined,
    path: path.relative(repoRoot, absolutePath).split(path.sep).join("/"),
  };
}

export function createTask(
  repoRoot: string,
  input: CreateTaskInput,
): { taskId: string; path: string } {
  const taskId = createUniqueTaskId(repoRoot, input.title);
  const absolutePath = taskPath(repoRoot, taskId);
  const priority = input.priority ?? "normal";
  const createdAt = new Date().toISOString();
  const markdown = [
    serializeFrontmatter({
      id: taskId,
      title: input.title.replace(/\r?\n/g, " "),
      status: "open",
      priority,
      created_by: "chatgpt",
      created_at: createdAt,
      claimed_by: "",
      completed_at: "",
    }),
    "",
    "# Objective",
    input.objective,
    "",
    "# Context",
    input.context || "None",
    "",
    "# Relevant files",
    renderList(input.relevantFiles),
    "",
    "# Constraints",
    renderList(input.constraints),
    "",
    "# Acceptance criteria",
    renderList(input.acceptanceCriteria),
    "",
    "# Verification commands",
    renderCommandBlock(input.verificationCommands),
    "",
    "# Notes",
    "",
  ].join("\n");
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, markdown, { encoding: "utf8", flag: "wx" });
  return { taskId, path: path.relative(repoRoot, absolutePath).split(path.sep).join("/") };
}

export function listTasks(repoRoot: string, status?: TaskStatus): TaskSummary[] {
  const tasksDirectory = path.join(repoRoot, ".ai/tasks");
  if (!fs.existsSync(tasksDirectory)) {
    return [];
  }
  return fs
    .readdirSync(tasksDirectory)
    .filter((file) => file.endsWith(".md"))
    .map((file) => {
      const absolutePath = path.join(tasksDirectory, file);
      return frontmatterToSummary(repoRoot, absolutePath, fs.readFileSync(absolutePath, "utf8"));
    })
    .filter((task) => !status || task.status === status)
    .sort((left, right) => {
      const priorityWeight: Record<Priority, number> = { high: 0, normal: 1, low: 2 };
      return (
        priorityWeight[left.priority] - priorityWeight[right.priority] ||
        left.createdAt.localeCompare(right.createdAt)
      );
    });
}

export function readTask(repoRoot: string, taskId: string): string {
  const absolutePath = taskPath(repoRoot, taskId);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Task not found: ${taskId}`);
  }
  return fs.readFileSync(absolutePath, "utf8");
}

export function claimTask(repoRoot: string, taskId: string, actor = "codex"): TaskSummary {
  const absolutePath = taskPath(repoRoot, taskId);
  const markdown = readTask(repoRoot, taskId);
  const { frontmatter, body } = parseFrontmatter(markdown);
  const status = taskStatusSchema.catch("open").parse(frontmatter.status);
  if (status === "claimed" || status === "done" || status === "reviewed") {
    return frontmatterToSummary(repoRoot, absolutePath, markdown);
  }
  frontmatter.status = "claimed";
  frontmatter.claimed_by = actor || "codex";
  fs.writeFileSync(absolutePath, `${serializeFrontmatter(frontmatter)}${body}`, "utf8");
  return frontmatterToSummary(repoRoot, absolutePath, fs.readFileSync(absolutePath, "utf8"));
}

export type WriteResultInput = {
  taskId: string;
  summary: string;
  filesChanged: string[];
  commandsRun: {
    command: string;
    exitCode: number;
    summary: string;
  }[];
  remainingRisks?: string[];
  notes?: string;
};

export function writeResult(
  repoRoot: string,
  input: WriteResultInput,
): { taskId: string; path: string } {
  readTask(repoRoot, input.taskId);
  const completedAt = new Date().toISOString();
  const absolutePath = resultPath(repoRoot, input.taskId);
  const commands =
    input.commandsRun.length === 0
      ? "| None | 0 | No commands reported |\n"
      : input.commandsRun
          .map(
            (command) =>
              `| ${escapeMarkdownTableCell(command.command)} | ${command.exitCode} | ${escapeMarkdownTableCell(command.summary)} |`,
          )
          .join("\n");
  const markdown = [
    serializeFrontmatter({
      task_id: input.taskId,
      status: "done",
      executor: "codex",
      completed_at: completedAt,
    }),
    "",
    "# Summary",
    input.summary,
    "",
    "# Files changed",
    renderList(input.filesChanged),
    "",
    "# Commands run",
    "| Command | Exit code | Summary |",
    "| --- | ---: | --- |",
    commands,
    "# Remaining risks",
    renderList(input.remainingRisks),
    "",
    "# Notes",
    input.notes || "None",
    "",
  ].join("\n");
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, markdown, "utf8");

  const taskAbsolutePath = taskPath(repoRoot, input.taskId);
  const taskMarkdown = fs.readFileSync(taskAbsolutePath, "utf8");
  const { frontmatter, body } = parseFrontmatter(taskMarkdown);
  frontmatter.status = "done";
  frontmatter.completed_at = completedAt;
  fs.writeFileSync(taskAbsolutePath, `${serializeFrontmatter(frontmatter)}${body}`, "utf8");

  return {
    taskId: input.taskId,
    path: path.relative(repoRoot, absolutePath).split(path.sep).join("/"),
  };
}

export function readResult(repoRoot: string, taskId: string): string | null {
  const absolutePath = resultPath(repoRoot, taskId);
  if (!fs.existsSync(absolutePath)) {
    return null;
  }
  return fs.readFileSync(absolutePath, "utf8");
}

export function writeReview(
  repoRoot: string,
  input: { taskId: string; verdict: "approved" | "changes_requested" | "blocked"; body: string },
): { taskId: string; path: string } {
  readTask(repoRoot, input.taskId);
  const absolutePath = reviewPath(repoRoot, input.taskId);
  const markdown = [
    serializeFrontmatter({
      task_id: input.taskId,
      verdict: input.verdict,
      reviewer: "chatgpt",
      reviewed_at: new Date().toISOString(),
    }),
    "",
    "# Review",
    input.body,
    "",
  ].join("\n");
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, markdown, "utf8");

  const taskAbsolutePath = taskPath(repoRoot, input.taskId);
  const taskMarkdown = fs.readFileSync(taskAbsolutePath, "utf8");
  const { frontmatter, body } = parseFrontmatter(taskMarkdown);
  frontmatter.status = "reviewed";
  fs.writeFileSync(taskAbsolutePath, `${serializeFrontmatter(frontmatter)}${body}`, "utf8");

  return {
    taskId: input.taskId,
    path: path.relative(repoRoot, absolutePath).split(path.sep).join("/"),
  };
}
