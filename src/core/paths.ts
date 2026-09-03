import fs from "node:fs";
import path from "node:path";

export type SafePath = {
  absolutePath: string;
  relativePath: string;
};

const DENIED_DIR_SEGMENTS = new Set([".git", "node_modules", "dist", "build", ".next", "coverage"]);

function toPosixPath(input: string): string {
  return input.split(path.sep).join("/");
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function normalizeRepoRelative(repoRoot: string, absolutePath: string): string {
  const relative = path.relative(repoRoot, absolutePath);
  return toPosixPath(relative || ".");
}

export function isDeniedRelative(relativePath: string): boolean {
  const normalized = toPosixPath(relativePath).replace(/^\.\/+/, "");
  const segments = normalized.split("/").filter(Boolean);
  const basename = segments.at(-1) ?? normalized;

  if (normalized === ".") {
    return false;
  }
  if (basename === ".env" || basename.startsWith(".env.")) {
    return true;
  }
  if (segments.some((segment) => segment === ".env" || segment.startsWith(".env."))) {
    return true;
  }
  if (segments.some((segment) => DENIED_DIR_SEGMENTS.has(segment))) {
    return true;
  }
  const lower = normalized.toLowerCase();
  if (lower.includes("secret") || lower.includes("token")) {
    return true;
  }
  return lower.endsWith(".pem") || lower.endsWith(".key");
}

export function assertAllowedRelative(relativePath: string): void {
  if (isDeniedRelative(relativePath)) {
    throw new Error(`Path is denied by policy: ${relativePath}`);
  }
}

export function resolveSafePath(repoRoot: string, inputPath = "."): SafePath {
  if (inputPath.trim() === "") {
    throw new Error("Path must not be empty");
  }
  const rootReal = fs.realpathSync.native(repoRoot);
  const resolved = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(rootReal, inputPath);

  if (!isInside(rootReal, resolved)) {
    throw new Error("Path escapes repository root");
  }

  let realPath = resolved;
  if (fs.existsSync(resolved)) {
    realPath = fs.realpathSync.native(resolved);
    if (!isInside(rootReal, realPath)) {
      throw new Error("Path resolves outside repository root");
    }
  } else {
    const parent = path.dirname(resolved);
    if (fs.existsSync(parent)) {
      const parentReal = fs.realpathSync.native(parent);
      if (!isInside(rootReal, parentReal)) {
        throw new Error("Path parent resolves outside repository root");
      }
    }
  }

  const relativePath = normalizeRepoRelative(rootReal, realPath);
  assertAllowedRelative(relativePath);
  return { absolutePath: realPath, relativePath };
}

export function ensureRepoWorkspace(repoRoot: string): void {
  if (!fs.existsSync(repoRoot) || !fs.statSync(repoRoot).isDirectory()) {
    throw new Error("Repository root must exist and be a directory");
  }
  for (const directory of [".ai/tasks", ".ai/results", ".ai/reviews", ".ai/logs", ".ai/context"]) {
    fs.mkdirSync(path.join(repoRoot, directory), { recursive: true });
  }

  const agentsPath = path.join(repoRoot, "AGENTS.md");
  if (!fs.existsSync(agentsPath)) {
    fs.writeFileSync(
      agentsPath,
      [
        "# Repository Agent Notes",
        "",
        "This repository is connected to codex-gptpro.",
        "Use `.ai/tasks`, `.ai/results`, and `.ai/reviews` for ChatGPT/Codex handoff.",
        "When asked to use `codex_gptpro`, first call `register_project` for this repository with `setDefault: true`; do not ask the user to do registration manually.",
        "Do not modify unrelated files.",
        "",
      ].join("\n"),
      "utf8",
    );
  } else {
    const contextPath = path.join(repoRoot, ".ai/context/codex-gptpro-workflow.md");
    if (!fs.existsSync(contextPath)) {
      fs.writeFileSync(
        contextPath,
        [
          "# codex-gptpro MCP Workflow",
          "",
          "ChatGPT is the planner/reviewer. Codex is the executor.",
          "Use `.ai/tasks` for implementation tasks, `.ai/results` for Codex reports, and `.ai/reviews` for review decisions.",
          "When asked to use `codex_gptpro`, first call `register_project` for this repository with `setDefault: true`; do not ask the user to do registration manually.",
          "Do not use codex-gptpro as a shell or patch application service.",
          "",
        ].join("\n"),
        "utf8",
      );
    }
  }
}

export function listVisibleDirectoryEntries(
  repoRoot: string,
  absoluteDirectory: string,
): fs.Dirent[] {
  const entries = fs.readdirSync(absoluteDirectory, { withFileTypes: true });
  return entries.filter((entry) => {
    const relative = normalizeRepoRelative(repoRoot, path.join(absoluteDirectory, entry.name));
    return !isDeniedRelative(relative);
  });
}
