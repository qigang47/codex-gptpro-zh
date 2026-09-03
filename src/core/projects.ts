import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AppConfig, ProjectConfig } from "./config.js";
import { ensureRepoWorkspace } from "./paths.js";

export const projectIdShape = {
  projectId: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{1,80}$/)
    .optional(),
};

export type ProjectScopedInput = {
  projectId?: string;
};

export const registerProjectInputSchema = {
  repoRoot: z.string().min(1),
  projectId: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{1,80}$/)
    .optional(),
  name: z.string().min(1).optional(),
  setDefault: z.boolean().optional(),
};

function slugifyProjectId(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "project";
}

function uniqueProjectId(config: AppConfig, baseId: string): string {
  if (!config.projects.some((project) => project.id === baseId)) {
    return baseId;
  }
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${baseId}-${index}`;
    if (!config.projects.some((project) => project.id === candidate)) {
      return candidate;
    }
  }
  throw new Error(`Could not allocate project id for: ${baseId}`);
}

function writeProjectRegistry(config: AppConfig): void {
  const registry = {
    defaultProjectId: config.defaultProjectId,
    projects: config.projects.map((project) => ({
      id: project.id,
      name: project.name,
      repoRoot: project.repoRoot,
    })),
  };
  const targetPath = config.projectRegistryPath;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(registry, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tempPath, targetPath);
}

export function resolveProject(config: AppConfig, projectId?: string): ProjectConfig {
  const id = projectId || config.defaultProjectId;
  if (!id) {
    throw new Error("No projects registered. Call register_project from /mcp-codex first.");
  }
  const project = config.projects.find((candidate) => candidate.id === id);
  if (!project) {
    throw new Error(`Unknown projectId: ${id}`);
  }
  return project;
}

export function withProject(config: AppConfig, input: ProjectScopedInput = {}): AppConfig {
  const project = resolveProject(config, input.projectId);
  return { ...config, repoRoot: project.repoRoot };
}

export function listProjects(config: AppConfig): {
  defaultProjectId: string;
  projects: Array<{ id: string; name: string; isDefault: boolean }>;
} {
  return {
    defaultProjectId: config.defaultProjectId,
    projects: config.projects.map((project) => ({
      id: project.id,
      name: project.name,
      isDefault: project.id === config.defaultProjectId,
    })),
  };
}

export function ensureProjectWorkspaces(config: AppConfig): void {
  for (const project of config.projects) {
    ensureRepoWorkspace(project.repoRoot);
  }
}

export function registerProject(
  config: AppConfig,
  input: z.infer<z.ZodObject<typeof registerProjectInputSchema>>,
): {
  id: string;
  name: string;
  repoRoot: string;
  isDefault: boolean;
  alreadyRegistered: boolean;
  registryPath: string;
} {
  const repoRoot = fs.realpathSync.native(path.resolve(input.repoRoot));
  const stat = fs.statSync(repoRoot);
  if (!stat.isDirectory()) {
    throw new Error("repoRoot must be a directory");
  }

  const existing = config.projects.find((project) => project.repoRoot === repoRoot);
  if (existing) {
    if (input.setDefault) {
      config.defaultProjectId = existing.id;
      config.repoRoot = existing.repoRoot;
      writeProjectRegistry(config);
    }
    return {
      ...existing,
      isDefault: existing.id === config.defaultProjectId,
      alreadyRegistered: true,
      registryPath: config.projectRegistryPath,
    };
  }

  const requestedId = input.projectId || slugifyProjectId(path.basename(repoRoot));
  const id = uniqueProjectId(config, requestedId);
  const project = {
    id,
    name: input.name?.trim() || id,
    repoRoot,
  };
  ensureRepoWorkspace(project.repoRoot);
  config.projects.push(project);
  if (input.setDefault || config.projects.length === 1) {
    config.defaultProjectId = project.id;
    config.repoRoot = project.repoRoot;
  }
  writeProjectRegistry(config);
  return {
    ...project,
    isDefault: project.id === config.defaultProjectId,
    alreadyRegistered: false,
    registryPath: config.projectRegistryPath,
  };
}
