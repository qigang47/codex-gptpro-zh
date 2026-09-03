import { spawn } from "node:child_process";
import type { AppConfig } from "../core/config.js";
import { isDeniedRelative } from "../core/paths.js";
import { truncateText } from "../core/sanitize.js";

type GitResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

function validateBase(base: string | undefined): string | undefined {
  if (!base) {
    return undefined;
  }
  if (base.startsWith("-") || /[\0\s]/.test(base) || !/^[A-Za-z0-9_./@{}~^:-]+$/.test(base)) {
    throw new Error("Invalid git base");
  }
  return base;
}

async function runGit(repoRoot: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: repoRoot,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode });
    });
  });
}

function splitChangedFiles(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function gitDiff(
  config: AppConfig,
  input: { base?: string; maxBytes?: number },
): Promise<{
  changedFiles: string[];
  redactedFiles: string[];
  diffStat: string;
  diff: string;
  truncated: boolean;
}> {
  const base = validateBase(input.base);
  const maxBytes = Math.min(
    Math.max(input.maxBytes ?? config.maxDiffBytes, 1),
    config.maxDiffBytes,
  );
  const baseArgs = base ? [base] : [];

  const names = await runGit(config.repoRoot, ["diff", "--name-only", ...baseArgs, "--"]);
  if (names.exitCode !== 0) {
    throw new Error(names.stderr || "git diff --name-only failed");
  }

  const changedFiles = splitChangedFiles(names.stdout);
  const allowedFiles = changedFiles.filter((file) => !isDeniedRelative(file));
  const redactedFiles = changedFiles.filter((file) => isDeniedRelative(file));

  const statArgs = ["diff", "--stat", ...baseArgs, "--", ...allowedFiles];
  const diffArgs = ["diff", ...baseArgs, "--", ...allowedFiles];

  const stat =
    allowedFiles.length > 0
      ? await runGit(config.repoRoot, statArgs)
      : { stdout: "", stderr: "", exitCode: 0 };
  if (stat.exitCode !== 0) {
    throw new Error(stat.stderr || "git diff --stat failed");
  }
  const diffResult =
    allowedFiles.length > 0
      ? await runGit(config.repoRoot, diffArgs)
      : { stdout: "", stderr: "", exitCode: 0 };
  if (diffResult.exitCode !== 0) {
    throw new Error(diffResult.stderr || "git diff failed");
  }
  const truncated = truncateText(diffResult.stdout, maxBytes);
  return {
    changedFiles: allowedFiles,
    redactedFiles,
    diffStat: stat.stdout,
    diff: truncated.text,
    truncated: truncated.truncated,
  };
}
