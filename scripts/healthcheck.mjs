#!/usr/bin/env node
import { config as loadDotEnv } from "dotenv";

loadDotEnv();

function readArg(name) {
  const prefix = `${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : undefined;
}

const baseUrl =
  readArg("--base-url") ||
  process.env.MCP_BASE_URL ||
  `http://127.0.0.1:${process.env.MCP_PORT || "8788"}`;

const retries = Number.parseInt(readArg("--retries") || "20", 10);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path, options = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}${path}`, options);
      const text = await response.text();
      return {
        status: response.status,
        contentType: response.headers.get("content-type"),
        text,
      };
    } catch (error) {
      lastError = error;
      if (attempt === retries) {
        break;
      }
      await sleep(Math.min(1000, 100 + attempt * 100));
    }
  }
  throw lastError;
}

function parseEventStream(text) {
  const dataLine = text.split(/\r?\n/).find((line) => line.startsWith("data: "));
  if (!dataLine) {
    throw new Error("Missing event-stream data line");
  }
  return JSON.parse(dataLine.slice("data: ".length));
}

async function mcpPost(path, body, headers = {}) {
  const response = await request(path, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return {
    ...response,
    json: parseEventStream(response.text),
  };
}

const checks = [];

const health = await request("/healthz");
checks.push({ name: "healthz", ok: health.status === 200, status: health.status });

const ready = await request("/readyz");
checks.push({ name: "readyz", ok: ready.status === 200, status: ready.status });

const rejectedOrigin = await request("/healthz", {
  headers: { origin: "https://example.invalid" },
});
checks.push({
  name: "invalid origin rejected",
  ok: rejectedOrigin.status === 403,
  status: rejectedOrigin.status,
});

const codexUnauthorized = await request("/mcp-codex");
checks.push({
  name: process.env.MCP_CODEX_TOKEN ? "mcp-codex unauthorized" : "mcp-codex auth optional",
  ok: process.env.MCP_CODEX_TOKEN
    ? codexUnauthorized.status === 401
    : codexUnauthorized.status !== 401,
  status: codexUnauthorized.status,
});

const pinArguments = process.env.MCP_PUBLIC_PIN ? { pin: process.env.MCP_PUBLIC_PIN } : {};
const projects = await mcpPost("/mcp", {
  jsonrpc: "2.0",
  id: 10,
  method: "tools/call",
  params: {
    name: "list_projects",
    arguments: pinArguments,
  },
});
checks.push({
  name: "public list_projects",
  ok: projects.status === 200 && !projects.json.result?.isError,
  status: projects.status,
});

let hasRegisteredProject = false;
try {
  const projectText = projects.json.result?.content?.[0]?.text;
  const projectPayload = projectText ? JSON.parse(projectText) : undefined;
  hasRegisteredProject =
    Array.isArray(projectPayload?.projects) && projectPayload.projects.length > 0;
} catch {
  hasRegisteredProject = false;
}

if (hasRegisteredProject) {
  const repoTree = await mcpPost("/mcp", {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "repo_tree",
      arguments: {
        ...pinArguments,
        path: ".",
        depth: 0,
        maxEntries: 10,
      },
    },
  });
  checks.push({
    name: "public repo_tree",
    ok: repoTree.status === 200 && !repoTree.json.result?.isError,
    status: repoTree.status,
  });
} else {
  checks.push({
    name: "public repo_tree skipped",
    ok: true,
    status: "no registered projects",
  });
}

const codexHeaders = process.env.MCP_CODEX_TOKEN
  ? { authorization: `Bearer ${process.env.MCP_CODEX_TOKEN}` }
  : {};
const codexTools = await mcpPost(
  "/mcp-codex",
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  },
  codexHeaders,
);
checks.push({
  name: "codex tools/list",
  ok: codexTools.status === 200 && Array.isArray(codexTools.json.result?.tools),
  status: codexTools.status,
});
const codexToolNames = codexTools.json.result?.tools?.map((tool) => tool.name) ?? [];
checks.push({
  name: "codex Pro tools exposed",
  ok:
    codexToolNames.includes("pro_browser_status") &&
    codexToolNames.includes("prepare_pro_browser") &&
    codexToolNames.includes("run_pro_prompt"),
  status: codexToolNames.length,
});

const ok = checks.every((check) => check.ok);
console.log(JSON.stringify({ ok, baseUrl, checks }, null, 2));
if (!ok) {
  process.exit(1);
}
