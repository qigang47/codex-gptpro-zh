#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const label = process.env.MCP_LAUNCHD_LABEL || "local.codex-gptpro";
const domain = `gui/${process.getuid?.() ?? ""}`;
const sourcePlist = path.join(projectRoot, "ops", `${label}.plist`);
const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
const targetPlist = path.join(launchAgentsDir, `${label}.plist`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: options.quiet ? "pipe" : "inherit",
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function bootstrapWithRetry() {
  let lastResult;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    lastResult = run("launchctl", ["bootstrap", domain, targetPlist], {
      allowFailure: true,
      quiet: true,
    });
    if (lastResult.status === 0) {
      return;
    }
    sleep(500 * attempt);
  }
  throw new Error(
    `launchctl bootstrap ${domain} ${targetPlist} failed: ${
      lastResult?.stderr || lastResult?.stdout || `status ${lastResult?.status}`
    }`,
  );
}

run("pnpm", ["build"]);
run(process.execPath, ["scripts/render-launchd-plist.mjs", "--output", sourcePlist]);
run("plutil", ["-lint", sourcePlist]);

run("launchctl", ["bootout", `${domain}/${label}`], { allowFailure: true, quiet: true });
fs.mkdirSync(launchAgentsDir, { recursive: true });
fs.copyFileSync(sourcePlist, targetPlist);
fs.chmodSync(targetPlist, 0o600);
bootstrapWithRetry();
run("launchctl", ["kickstart", "-k", `${domain}/${label}`]);

console.log(
  JSON.stringify(
    {
      ok: true,
      label,
      targetPlist,
    },
    null,
    2,
  ),
);
