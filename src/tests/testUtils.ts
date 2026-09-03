import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../core/config.js";
import { ensureRepoWorkspace } from "../core/paths.js";

export function makeTempRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gptpro-"));
  fs.writeFileSync(
    path.join(repoRoot, "package.json"),
    JSON.stringify(
      {
        scripts: {
          test: "node -e \"console.log('ok')\"",
          lint: "node -e \"console.log('lint')\"",
          build: "node -e \"console.log('build')\"",
          typecheck: "node -e \"console.log('typecheck')\"",
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "# Existing\n");
  ensureRepoWorkspace(repoRoot);
  return repoRoot;
}

export function makeConfig(repoRoot = makeTempRepo()): AppConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    repoRoot,
    defaultProjectId: "default",
    projects: [{ id: "default", name: "default", repoRoot }],
    projectRegistryPath: path.join(os.tmpdir(), `codex-gptpro-projects-${Date.now()}.json`),
    publicPin: "pin",
    allowInsecurePublicNoPin: false,
    codexToken: "token",
    allowedOrigins: [],
    maxReadBytes: 120_000,
    maxDiffBytes: 200_000,
    maxGrepResults: 100,
  };
}
