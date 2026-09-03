#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(projectRoot, ".env");
const registryPath = path.join(projectRoot, "projects.local.json");

function readOption(name) {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const inline = args.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) {
    return inline.slice(name.length + 3);
  }
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function randomSecret(bytes) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function projectIdFromPath(repoRoot) {
  return (
    path
      .basename(repoRoot)
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "default"
  );
}

function readEnv() {
  if (!fs.existsSync(envPath)) {
    return {};
  }
  return parse(fs.readFileSync(envPath, "utf8"));
}

function writeEnv(env) {
  const orderedKeys = [
    "MCP_PORT",
    "MCP_PROJECTS_FILE",
    "MCP_DEFAULT_PROJECT_ID",
    "MCP_PUBLIC_PIN",
    "MCP_CODEX_TOKEN",
    "MCP_ALLOWED_ORIGINS",
    "MCP_MAX_READ_BYTES",
    "MCP_MAX_DIFF_BYTES",
    "MCP_MAX_GREP_RESULTS",
    "MCP_INSECURE_PUBLIC_NO_PIN",
  ];
  const lines = [];
  for (const key of orderedKeys) {
    if (env[key] !== undefined && env[key] !== "") {
      lines.push(`${key}=${env[key]}`);
    }
  }
  for (const key of Object.keys(env).sort()) {
    if (!orderedKeys.includes(key) && env[key] !== "") {
      lines.push(`${key}=${env[key]}`);
    }
  }
  fs.writeFileSync(envPath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(envPath, 0o600);
}

function readRegistry() {
  if (!fs.existsSync(registryPath)) {
    return { defaultProjectId: "default", projects: [] };
  }
  return JSON.parse(fs.readFileSync(registryPath, "utf8"));
}

function writeRegistry(registry) {
  const tempPath = `${registryPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(registry, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tempPath, registryPath);
  fs.chmodSync(registryPath, 0o600);
}

const repoRoot = path.resolve(readOption("repo") || process.cwd());
if (!fs.existsSync(repoRoot) || !fs.statSync(repoRoot).isDirectory()) {
  throw new Error(`Repo root does not exist or is not a directory: ${repoRoot}`);
}

const requestedProjectId = readOption("project-id") || projectIdFromPath(repoRoot);
const projectName = readOption("name") || requestedProjectId;
const env = readEnv();

env.MCP_PORT ||= "8788";
env.MCP_DEFAULT_PROJECT_ID ||= requestedProjectId;
env.MCP_PUBLIC_PIN ||= randomSecret(12);
env.MCP_CODEX_TOKEN ||= randomSecret(32);
env.MCP_MAX_READ_BYTES ||= "120000";
env.MCP_MAX_DIFF_BYTES ||= "200000";
env.MCP_MAX_GREP_RESULTS ||= "100";
env.MCP_INSECURE_PUBLIC_NO_PIN ||= "false";

const registry = readRegistry();
registry.projects ||= [];
const existing = registry.projects.find((project) => project.repoRoot === repoRoot);
if (!existing) {
  let projectId = requestedProjectId;
  for (let index = 2; registry.projects.some((project) => project.id === projectId); index += 1) {
    projectId = `${requestedProjectId}-${index}`;
  }
  registry.projects.push({
    id: projectId,
    name: projectName,
    repoRoot,
  });
  registry.defaultProjectId ||= projectId;
  env.MCP_DEFAULT_PROJECT_ID = registry.defaultProjectId;
} else {
  existing.name = existing.name || projectName;
  registry.defaultProjectId ||= existing.id;
  if (!registry.projects.some((project) => project.id === env.MCP_DEFAULT_PROJECT_ID)) {
    env.MCP_DEFAULT_PROJECT_ID = registry.defaultProjectId;
  }
}

writeEnv(env);
writeRegistry(registry);

console.log(
  JSON.stringify(
    {
      ok: true,
      envPath,
      registryPath,
      repoRoot,
      defaultProjectId: registry.defaultProjectId,
      projects: registry.projects.map((project) => ({ id: project.id, name: project.name })),
    },
    null,
    2,
  ),
);
