#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parse } from "dotenv";

const projectRoot = process.cwd();
const envPath = path.join(projectRoot, ".env");
const distIndexPath = path.join(projectRoot, "dist/index.js");
const defaultProjectsPath = path.join(projectRoot, "projects.local.json");
const errors = [];
const warnings = [];

function check(condition, message) {
  if (!condition) {
    errors.push(message);
  }
}

function warn(condition, message) {
  if (!condition) {
    warnings.push(message);
  }
}

const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
check(nodeMajor >= 20, `Node.js 20+ is required; current=${process.versions.node}`);
check(fs.existsSync(distIndexPath), "dist/index.js is missing. Run `pnpm build` first.");
warn(fs.existsSync(envPath), ".env is not present; using built-in local defaults.");

let env = {};
if (fs.existsSync(envPath)) {
  const stat = fs.statSync(envPath);
  warn((stat.mode & 0o077) === 0, ".env should be chmod 600 or stricter for production.");
  env = parse(fs.readFileSync(envPath, "utf8"));
}

for (const name of ["MCP_PUBLIC_PIN", "MCP_CODEX_TOKEN"]) {
  warn(!String(env[name] ?? "").includes("change-me"), `${name} still looks like a placeholder.`);
}

warn(
  Boolean(env.MCP_PUBLIC_PIN),
  "MCP_PUBLIC_PIN is unset; /mcp tool calls are unpinned. Keep /mcp on localhost only or set a PIN before exposing it.",
);
warn(
  Boolean(env.MCP_CODEX_TOKEN),
  "MCP_CODEX_TOKEN is unset; /mcp-codex is unauthenticated. Keep it on localhost only or set a bearer token.",
);

function checkRepoRoot(repoRoot, label) {
  check(fs.existsSync(repoRoot), `${label} does not exist: ${repoRoot}`);
  if (fs.existsSync(repoRoot)) {
    check(fs.statSync(repoRoot).isDirectory(), `${label} is not a directory: ${repoRoot}`);
  }
}

const projectsFile =
  env.MCP_PROJECTS_FILE || (fs.existsSync(defaultProjectsPath) ? defaultProjectsPath : "");
if (projectsFile) {
  const projectsPath = path.resolve(projectsFile);
  check(fs.existsSync(projectsPath), `MCP_PROJECTS_FILE does not exist: ${projectsPath}`);
  if (fs.existsSync(projectsPath)) {
    const parsed = JSON.parse(fs.readFileSync(projectsPath, "utf8"));
    const projects = Array.isArray(parsed) ? parsed : parsed.projects;
    check(Array.isArray(projects) && projects.length > 0, "MCP_PROJECTS_FILE has no projects");
    for (const project of projects ?? []) {
      check(Boolean(project.id), "Project id is required");
      check(
        Boolean(project.repoRoot),
        `Project repoRoot is required: ${project.id ?? "(missing id)"}`,
      );
      if (project.repoRoot) {
        checkRepoRoot(project.repoRoot, `Project repoRoot ${project.id}`);
      }
    }
  }
} else {
  warnings.push("No projects are registered yet. Start the server and call register_project.");
}

warn(
  env.MCP_INSECURE_PUBLIC_NO_PIN !== "true",
  "MCP_INSECURE_PUBLIC_NO_PIN=true is unsafe outside localhost-only development.",
);

const result = {
  ok: errors.length === 0,
  projectRoot,
  node: process.versions.node,
  errors,
  warnings,
};

console.log(JSON.stringify(result, null, 2));
if (errors.length > 0) {
  process.exit(1);
}
