import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config as loadDotEnv } from "dotenv";

export type AppConfig = {
  port: number;
  host: string;
  repoRoot: string;
  defaultProjectId: string;
  projects: ProjectConfig[];
  projectRegistryPath: string;
  publicPin?: string;
  allowInsecurePublicNoPin: boolean;
  codexToken?: string;
  allowedOrigins: string[];
  maxReadBytes: number;
  maxDiffBytes: number;
  maxGrepResults: number;
};

export type ProjectConfig = {
  id: string;
  name: string;
  repoRoot: string;
};

type Env = Record<string, string | undefined>;

const DEFAULT_PORT = 8788;
const DEFAULT_MAX_READ_BYTES = 120_000;
const DEFAULT_MAX_DIFF_BYTES = 200_000;
const DEFAULT_MAX_GREP_RESULTS = 100;
const DEFAULT_PROJECTS_FILE = "projects.local.json";

function parsePositiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseBoolean(value: string | undefined): boolean {
  return value?.toLowerCase() === "true";
}

function parseCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function validateProjectId(id: string): void {
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(id)) {
    throw new Error(`Invalid project id: ${id}`);
  }
}

function normalizeProject(input: { id: string; name?: string; repoRoot: string }): ProjectConfig {
  validateProjectId(input.id);
  const repoRoot = path.resolve(input.repoRoot);
  const repoRootStat = fs.existsSync(repoRoot) ? fs.statSync(repoRoot) : null;
  if (!repoRootStat?.isDirectory()) {
    throw new Error(`Project repoRoot must exist and be a directory: ${input.id}`);
  }
  return {
    id: input.id,
    name: input.name?.trim() || input.id,
    repoRoot,
  };
}

function defaultProjectsFilePath(): string {
  return path.resolve(process.cwd(), DEFAULT_PROJECTS_FILE);
}

function parseProjectsFile(projectsFilePath: string): {
  projects: ProjectConfig[];
  defaultProjectId?: string;
} {
  const absolutePath = path.resolve(projectsFilePath);
  const parsed = JSON.parse(fs.readFileSync(absolutePath, "utf8")) as
    | Array<{ id: string; name?: string; repoRoot: string }>
    | {
        defaultProjectId?: string;
        projects?: Array<{ id: string; name?: string; repoRoot: string }>;
      };
  const rawProjects = Array.isArray(parsed) ? parsed : parsed.projects;
  if (!rawProjects?.length) {
    throw new Error("MCP_PROJECTS_FILE must contain at least one project");
  }
  return {
    projects: rawProjects.map(normalizeProject),
    defaultProjectId: Array.isArray(parsed) ? undefined : parsed.defaultProjectId,
  };
}

function loadProjects(merged: Env): {
  projects: ProjectConfig[];
  defaultProjectId: string;
  repoRoot: string;
  projectRegistryPath: string;
} {
  const defaultProjectsFile = defaultProjectsFilePath();
  const projectsFile =
    merged.MCP_PROJECTS_FILE ||
    (merged.MCP_DISABLE_AUTO_PROJECTS_FILE !== "true" && fs.existsSync(defaultProjectsFile)
      ? defaultProjectsFile
      : undefined);
  const defaultProjectIdInput = merged.MCP_DEFAULT_PROJECT_ID;
  if (projectsFile) {
    const loaded = parseProjectsFile(projectsFile);
    const seen = new Set<string>();
    for (const project of loaded.projects) {
      if (seen.has(project.id)) {
        throw new Error(`Duplicate project id: ${project.id}`);
      }
      seen.add(project.id);
    }
    const defaultProjectId =
      defaultProjectIdInput || loaded.defaultProjectId || loaded.projects[0].id;
    validateProjectId(defaultProjectId);
    const defaultProject = loaded.projects.find((project) => project.id === defaultProjectId);
    if (!defaultProject) {
      throw new Error(`Default project not found: ${defaultProjectId}`);
    }
    return {
      projects: loaded.projects,
      defaultProjectId,
      repoRoot: defaultProject.repoRoot,
      projectRegistryPath: path.resolve(projectsFile),
    };
  }

  return {
    projects: [],
    defaultProjectId: "",
    repoRoot: process.cwd(),
    projectRegistryPath: defaultProjectsFile,
  };
}

export function loadConfig(env: Env = process.env): AppConfig {
  loadDotEnv();
  const merged = env === process.env ? { ...process.env, ...env } : { ...env };
  const projectConfig = loadProjects(
    env === process.env
      ? merged
      : {
          ...merged,
          MCP_PROJECTS_FILE: env.MCP_PROJECTS_FILE,
          MCP_DISABLE_AUTO_PROJECTS_FILE: "true",
        },
  );

  const allowInsecurePublicNoPin = parseBoolean(merged.MCP_INSECURE_PUBLIC_NO_PIN);
  const publicPin = merged.MCP_PUBLIC_PIN;
  const codexToken = merged.MCP_CODEX_TOKEN;

  return {
    port: parsePositiveInt(merged.MCP_PORT, DEFAULT_PORT, "MCP_PORT"),
    host: "127.0.0.1",
    repoRoot: projectConfig.repoRoot,
    defaultProjectId: projectConfig.defaultProjectId,
    projects: projectConfig.projects,
    projectRegistryPath: projectConfig.projectRegistryPath,
    publicPin,
    allowInsecurePublicNoPin,
    codexToken,
    allowedOrigins: parseCsv(merged.MCP_ALLOWED_ORIGINS),
    maxReadBytes: parsePositiveInt(
      merged.MCP_MAX_READ_BYTES,
      DEFAULT_MAX_READ_BYTES,
      "MCP_MAX_READ_BYTES",
    ),
    maxDiffBytes: parsePositiveInt(
      merged.MCP_MAX_DIFF_BYTES,
      DEFAULT_MAX_DIFF_BYTES,
      "MCP_MAX_DIFF_BYTES",
    ),
    maxGrepResults: parsePositiveInt(
      merged.MCP_MAX_GREP_RESULTS,
      DEFAULT_MAX_GREP_RESULTS,
      "MCP_MAX_GREP_RESULTS",
    ),
  };
}

export function validatePublicPin(config: AppConfig, pin: string): void {
  if (config.allowInsecurePublicNoPin) {
    return;
  }
  if (!config.publicPin) {
    return;
  }
  if (!config.publicPin || !constantTimeEqual(pin, config.publicPin)) {
    throw new Error("Invalid MCP public PIN");
  }
}

export function isValidCodexAuthorization(
  config: AppConfig,
  authorization: string | undefined,
): boolean {
  if (!config.codexToken) {
    return true;
  }
  const prefix = "Bearer ";
  if (!authorization?.startsWith(prefix)) {
    return false;
  }
  return constantTimeEqual(authorization.slice(prefix.length), config.codexToken);
}
