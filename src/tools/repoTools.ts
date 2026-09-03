import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../core/config.js";
import {
  isDeniedRelative,
  listVisibleDirectoryEntries,
  normalizeRepoRelative,
  resolveSafePath,
} from "../core/paths.js";
import { isLikelyBinary, truncateLinePreview, truncateText } from "../core/sanitize.js";

export type RepoTreeInput = {
  path?: string;
  depth?: number;
  maxEntries?: number;
};

export type ReadFileInput = {
  path: string;
  maxBytes?: number;
};

export type GrepInput = {
  query: string;
  glob?: string;
  maxResults?: number;
};

export type GrepResult = {
  path: string;
  line: number;
  preview: string;
};

const RG_DENY_GLOBS = [
  "!**/.env",
  "!**/.env.*",
  "!**/.git/**",
  "!**/node_modules/**",
  "!**/dist/**",
  "!**/build/**",
  "!**/.next/**",
  "!**/coverage/**",
  "!**/*secret*",
  "!**/*token*",
  "!**/*.pem",
  "!**/*.key",
];

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) {
    return fallback;
  }
  return Math.min(Math.max(value, min), max);
}

function fileKind(entryPath: string): "d" | "f" | "l" {
  const stat = fs.lstatSync(entryPath);
  if (stat.isSymbolicLink()) {
    return "l";
  }
  return stat.isDirectory() ? "d" : "f";
}

export function repoTree(
  config: AppConfig,
  input: RepoTreeInput,
): { root: string; tree: string; entries: number; truncated: boolean } {
  const safePath = resolveSafePath(config.repoRoot, input.path ?? ".");
  const depth = clamp(input.depth, 2, 0, 8);
  const maxEntries = clamp(input.maxEntries, 100, 1, 1_000);
  let count = 0;
  let truncated = false;
  const lines: string[] = [];

  function walk(directory: string, prefix: string, remainingDepth: number): void {
    if (truncated || remainingDepth < 0) {
      return;
    }
    const entries = listVisibleDirectoryEntries(config.repoRoot, directory).sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) {
        return left.isDirectory() ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });

    for (const entry of entries) {
      if (count >= maxEntries) {
        truncated = true;
        return;
      }
      const absoluteEntryPath = path.join(directory, entry.name);
      const relative = normalizeRepoRelative(config.repoRoot, absoluteEntryPath);
      if (isDeniedRelative(relative)) {
        continue;
      }
      const kind = fileKind(absoluteEntryPath);
      lines.push(`${prefix}${kind} ${relative}`);
      count += 1;
      if (kind === "d" && remainingDepth > 0) {
        walk(absoluteEntryPath, `${prefix}  `, remainingDepth - 1);
      }
    }
  }

  const stat = fs.statSync(safePath.absolutePath);
  if (stat.isDirectory()) {
    walk(safePath.absolutePath, "", depth);
  } else {
    lines.push(`f ${safePath.relativePath}`);
    count = 1;
  }

  return {
    root: safePath.relativePath,
    tree: lines.join("\n"),
    entries: count,
    truncated,
  };
}

export function readFile(
  config: AppConfig,
  input: ReadFileInput,
): { path: string; text: string; bytesRead: number; truncated: boolean } {
  const safePath = resolveSafePath(config.repoRoot, input.path);
  const stat = fs.statSync(safePath.absolutePath);
  if (!stat.isFile()) {
    throw new Error("Path is not a file");
  }
  const maxBytes = Math.min(
    Math.max(input.maxBytes ?? config.maxReadBytes, 1),
    config.maxReadBytes,
  );
  const fd = fs.openSync(safePath.absolutePath, "r");
  try {
    const bytesToRead = Math.min(stat.size, maxBytes + 1);
    const buffer = Buffer.alloc(bytesToRead);
    const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, 0);
    const actual = buffer.subarray(0, bytesRead);
    if (isLikelyBinary(actual)) {
      throw new Error("Refusing to read likely binary file");
    }
    const truncated = truncateText(actual.toString("utf8"), maxBytes);
    return {
      path: safePath.relativePath,
      text: truncated.text,
      bytesRead: truncated.bytes,
      truncated: truncated.truncated || stat.size > maxBytes,
    };
  } finally {
    fs.closeSync(fd);
  }
}

async function runRg(
  config: AppConfig,
  input: GrepInput,
  maxResults: number,
): Promise<GrepResult[] | null> {
  const args = [
    "--line-number",
    "--no-heading",
    "--color",
    "never",
    "--max-count",
    String(maxResults),
    ...RG_DENY_GLOBS.flatMap((glob) => ["--glob", glob]),
  ];
  if (input.glob) {
    args.push("--glob", input.glob);
  }
  args.push("--", input.query, ".");

  return new Promise((resolve, reject) => {
    const child = spawn("rg", args, { cwd: config.repoRoot, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        resolve(null);
        return;
      }
      reject(error);
    });
    child.on("close", (exitCode) => {
      if (exitCode !== 0 && exitCode !== 1) {
        reject(new Error(stderr || "rg failed"));
        return;
      }
      const results = stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const match = /^(.*?):(\d+):(.*)$/.exec(line);
          if (!match) {
            return null;
          }
          const relative = match[1].replace(/^\.\//, "");
          if (isDeniedRelative(relative)) {
            return null;
          }
          return {
            path: relative,
            line: Number.parseInt(match[2], 10),
            preview: truncateLinePreview(match[3]),
          };
        })
        .filter((result): result is GrepResult => result !== null)
        .slice(0, maxResults);
      resolve(results);
    });
  });
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

function jsGrep(config: AppConfig, input: GrepInput, maxResults: number): GrepResult[] {
  const results: GrepResult[] = [];
  const globPattern = input.glob ? globToRegExp(input.glob) : null;

  function walk(directory: string): void {
    if (results.length >= maxResults) {
      return;
    }
    for (const entry of listVisibleDirectoryEntries(config.repoRoot, directory)) {
      const absoluteEntryPath = path.join(directory, entry.name);
      const relative = normalizeRepoRelative(config.repoRoot, absoluteEntryPath);
      if (isDeniedRelative(relative) || (globPattern && !globPattern.test(relative))) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(absoluteEntryPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const buffer = fs.readFileSync(absoluteEntryPath);
      if (isLikelyBinary(buffer)) {
        continue;
      }
      const lines = buffer.toString("utf8").split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        if (line.includes(input.query)) {
          results.push({
            path: relative,
            line: index + 1,
            preview: truncateLinePreview(line),
          });
          if (results.length >= maxResults) {
            return;
          }
        }
      }
    }
  }

  walk(config.repoRoot);
  return results;
}

export async function grepRepo(config: AppConfig, input: GrepInput): Promise<GrepResult[]> {
  if (!input.query) {
    throw new Error("query is required");
  }
  const maxResults = Math.min(
    Math.max(input.maxResults ?? config.maxGrepResults, 1),
    config.maxGrepResults,
  );
  const rgResults = await runRg(config, input, maxResults);
  return rgResults ?? jsGrep(config, input, maxResults);
}
