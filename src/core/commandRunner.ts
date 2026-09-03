import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { truncateText } from "./sanitize.js";

export type CheckName = "typecheck" | "lint" | "test" | "build";

export type CheckResult = {
  name: CheckName;
  command: string[];
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

const MAX_OUTPUT_BYTES = 60_000;

function detectPackageManager(repoRoot: string): "pnpm" | "yarn" | "npm" {
  if (fs.existsSync(path.join(repoRoot, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (fs.existsSync(path.join(repoRoot, "yarn.lock"))) {
    return "yarn";
  }
  if (fs.existsSync(path.join(repoRoot, "package-lock.json"))) {
    return "npm";
  }
  return "pnpm";
}

function readPackageScripts(repoRoot: string): Record<string, string> {
  const packageJsonPath = path.join(repoRoot, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error("Registered repository package.json not found");
  }
  const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    scripts?: Record<string, string>;
  };
  return parsed.scripts ?? {};
}

function executableName(command: string): string {
  return process.platform === "win32" ? `${command}.cmd` : command;
}

function pathEntries(): string[] {
  const home = os.homedir();
  return [
    process.env.PNPM_HOME,
    path.dirname(process.execPath),
    path.join(home, "Library/pnpm"),
    path.join(home, ".local/share/pnpm"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    process.env.PATH,
  ]
    .filter(Boolean)
    .flatMap((entry) => String(entry).split(path.delimiter))
    .filter(Boolean);
}

function commandEnv(): NodeJS.ProcessEnv {
  const uniquePath = [...new Set(pathEntries())].join(path.delimiter);
  return { ...process.env, CI: "true", PATH: uniquePath };
}

function resolveExecutable(command: string): string {
  const executable = executableName(command);
  for (const directory of pathEntries()) {
    const candidate = path.join(directory, executable);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH candidates.
    }
  }
  return command;
}

export async function runPackageCheck(
  repoRoot: string,
  name: CheckName,
  timeoutSec = 120,
): Promise<CheckResult> {
  const scripts = readPackageScripts(repoRoot);
  if (!scripts[name]) {
    throw new Error(`package.json script not found: ${name}`);
  }
  const packageManager = detectPackageManager(repoRoot);
  const executable = resolveExecutable(packageManager);
  const args = ["run", name];
  const timeoutMs = Math.min(Math.max(timeoutSec, 1), 600) * 1000;

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: repoRoot,
      shell: false,
      env: commandEnv(),
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const finish = (
      result: Omit<CheckResult, "stdout" | "stderr" | "stdoutTruncated" | "stderrTruncated">,
    ) => {
      const stdoutResult = truncateText(stdout, MAX_OUTPUT_BYTES);
      const stderrResult = truncateText(stderr, MAX_OUTPUT_BYTES);
      resolve({
        ...result,
        stdout: stdoutResult.text,
        stderr: stderrResult.text,
        stdoutTruncated: stdoutResult.truncated,
        stderrTruncated: stderrResult.truncated,
      });
    };
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      finish({
        name,
        command: [executable, ...args],
        exitCode: null,
        timedOut: true,
      });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      finish({
        name,
        command: [executable, ...args],
        exitCode,
        timedOut: false,
      });
    });
  });
}

export function commandToString(command: string[]): string {
  return command.join(" ");
}
