#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const label = process.env.MCP_LAUNCHD_LABEL || "local.codex-gptpro";
const domain = `gui/${process.getuid?.() ?? ""}`;
const targetPlist = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);

spawnSync("launchctl", ["bootout", `${domain}/${label}`], { stdio: "ignore" });
if (fs.existsSync(targetPlist)) {
  fs.rmSync(targetPlist);
}

console.log(JSON.stringify({ ok: true, label, removed: targetPlist }, null, 2));
