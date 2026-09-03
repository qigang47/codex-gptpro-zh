#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(projectRoot, ".env");
const codexDir = path.join(os.homedir(), ".codex");
const configPath = path.join(codexDir, "config.toml");
const env = fs.existsSync(envPath) ? parse(fs.readFileSync(envPath, "utf8")) : {};
const codexToken = process.env.MCP_CODEX_TOKEN || env.MCP_CODEX_TOKEN;
const port = process.env.MCP_PORT || env.MCP_PORT || "8788";
const serverName = "codex_gptpro";
const legacyServerNames = ["webgpt"];

fs.mkdirSync(codexDir, { recursive: true });
const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
const bearerLine = codexToken ? 'bearer_token_env_var = "MCP_CODEX_TOKEN"\n' : "";
const block = `[mcp_servers.${serverName}]
url = "http://127.0.0.1:${port}/mcp-codex"
${bearerLine}startup_timeout_sec = 20
tool_timeout_sec = 1200
enabled = true
default_tools_approval_mode = "prompt"
`;

function removeServerBlock(input, name) {
  const pattern = new RegExp(`\\n?\\[mcp_servers\\.${name}\\]\\n(?:[^\\n]*\\n)*?(?=\\n\\[|$)`, "m");
  return input.replace(pattern, "");
}

const withoutOldAliases = [serverName, ...legacyServerNames].reduce(
  (input, name) => removeServerBlock(input, name),
  existing,
);
const next = `${withoutOldAliases.trimEnd()}${withoutOldAliases.trim() ? "\n\n" : ""}${block}`;
fs.writeFileSync(configPath, next.endsWith("\n") ? next : `${next}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
fs.chmodSync(configPath, 0o600);

if (process.platform === "darwin" && codexToken) {
  spawnSync("launchctl", ["setenv", "MCP_CODEX_TOKEN", codexToken], {
    stdio: "ignore",
  });
}

console.log(
  JSON.stringify(
    {
      ok: true,
      configPath,
      server: serverName,
      usesBearerToken: Boolean(codexToken),
      launchctlEnvSet: process.platform === "darwin" && Boolean(codexToken),
    },
    null,
    2,
  ),
);
