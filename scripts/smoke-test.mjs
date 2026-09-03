#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const projectRoot = process.cwd();
const distIndexPath = path.join(projectRoot, "dist/index.js");

if (!fs.existsSync(distIndexPath)) {
  console.error("dist/index.js is missing. Run `pnpm build` first.");
  process.exit(1);
}

const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gptpro-smoke-repo-"));
const secondRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gptpro-smoke-repo-two-"));
const registeredRepoRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "codex-gptpro-smoke-registered-repo-"),
);
fs.writeFileSync(path.join(repoRoot, "package.json"), JSON.stringify({ scripts: {} }, null, 2));
fs.writeFileSync(
  path.join(secondRepoRoot, "package.json"),
  JSON.stringify({ scripts: {} }, null, 2),
);
fs.writeFileSync(path.join(secondRepoRoot, "second.txt"), "from second project\n");
fs.writeFileSync(
  path.join(registeredRepoRoot, "package.json"),
  JSON.stringify({ scripts: {} }, null, 2),
);
fs.writeFileSync(path.join(registeredRepoRoot, "registered.txt"), "from registered project\n");
const projectsFile = path.join(os.tmpdir(), `codex-gptpro-projects-${process.pid}.json`);
fs.writeFileSync(
  projectsFile,
  JSON.stringify(
    {
      defaultProjectId: "primary",
      projects: [
        { id: "primary", name: "Primary", repoRoot },
        { id: "secondary", name: "Secondary", repoRoot: secondRepoRoot },
      ],
    },
    null,
    2,
  ),
);

const port = 19_000 + Math.floor(Math.random() * 20_000);
const publicPin = "smoke-pin";
const codexToken = "smoke-codex-token";
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [distIndexPath], {
  cwd: projectRoot,
  env: {
    ...process.env,
    NODE_ENV: "production",
    MCP_PORT: String(port),
    MCP_PROJECTS_FILE: projectsFile,
    MCP_DEFAULT_PROJECT_ID: "primary",
    MCP_PUBLIC_PIN: publicPin,
    MCP_CODEX_TOKEN: codexToken,
    MCP_INSECURE_PUBLIC_NO_PIN: "false",
    MCP_PRO_BROWSER_MODE: "mock",
    MCP_PRO_MOCK_RESPONSE: "codex-gptpro smoke pro ok",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString("utf8");
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

function parseEventStream(text) {
  const dataLine = text.split(/\r?\n/).find((line) => line.startsWith("data: "));
  if (!dataLine) {
    throw new Error(`Missing event-stream data line in: ${text.slice(0, 500)}`);
  }
  return JSON.parse(dataLine.slice("data: ".length));
}

async function waitForHealth() {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early code=${child.exitCode} stderr=${stderr}`);
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.status === 200) {
        return;
      }
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`server did not become healthy stdout=${stdout} stderr=${stderr}`);
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  return { response, text };
}

async function mcpPost(path, body, headers = {}) {
  const { response, text } = await request(path, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    json: parseEventStream(text),
  };
}

async function stopServer() {
  if (child.exitCode !== null) {
    return child.exitCode;
  }
  child.kill("SIGTERM");
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("server did not stop after SIGTERM"));
    }, 10_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

const checks = [];

try {
  await waitForHealth();

  const health = await request("/healthz");
  checks.push({ name: "healthz", ok: health.response.status === 200 });

  const ready = await request("/readyz");
  checks.push({ name: "readyz", ok: ready.response.status === 200 });

  const rejectedOrigin = await request("/healthz", {
    headers: { origin: "https://example.invalid" },
  });
  checks.push({ name: "invalid origin rejected", ok: rejectedOrigin.response.status === 403 });

  const unauthorized = await request("/mcp-codex");
  checks.push({ name: "codex unauthorized", ok: unauthorized.response.status === 401 });

  const wrongPin = await mcpPost("/mcp", {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "repo_tree",
      arguments: { pin: "wrong", path: ".", depth: 1, maxEntries: 10 },
    },
  });
  checks.push({
    name: "wrong pin rejected",
    ok: wrongPin.status === 200 && wrongPin.json.result?.isError === true,
  });

  const repoTree = await mcpPost("/mcp", {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "repo_tree",
      arguments: { pin: publicPin, path: ".", depth: 1, maxEntries: 10 },
    },
  });
  checks.push({
    name: "repo_tree succeeds",
    ok: repoTree.status === 200 && !repoTree.json.result?.isError,
  });

  const secondRead = await mcpPost("/mcp", {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "read_file",
      arguments: { pin: publicPin, projectId: "secondary", path: "second.txt" },
    },
  });
  checks.push({
    name: "projectId selects secondary project",
    ok:
      secondRead.status === 200 &&
      !secondRead.json.result?.isError &&
      secondRead.json.result?.content?.[0]?.text.includes("from second project"),
  });

  const codexTools = await mcpPost(
    "/mcp-codex",
    { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
    { authorization: `Bearer ${codexToken}` },
  );
  checks.push({
    name: "codex tools/list succeeds",
    ok: codexTools.status === 200 && Array.isArray(codexTools.json.result?.tools),
  });
  const codexToolNames = codexTools.json.result?.tools?.map((tool) => tool.name) ?? [];
  checks.push({
    name: "codex exposes Pro tools",
    ok:
      codexToolNames.includes("pro_browser_status") &&
      codexToolNames.includes("prepare_pro_browser") &&
      codexToolNames.includes("run_pro_prompt"),
  });

  const preparedProBrowser = await mcpPost(
    "/mcp-codex",
    {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "prepare_pro_browser",
        arguments: {},
      },
    },
    { authorization: `Bearer ${codexToken}` },
  );
  checks.push({
    name: "codex prepare_pro_browser succeeds",
    ok:
      preparedProBrowser.status === 200 &&
      !preparedProBrowser.json.result?.isError &&
      preparedProBrowser.json.result?.content?.[0]?.text.includes("Mock mode"),
  });

  const proPrompt = await mcpPost(
    "/mcp-codex",
    {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "run_pro_prompt",
        arguments: {
          projectId: "primary",
          title: "Smoke Pro Prompt",
          prompt: "Return smoke ok",
          confirmSendToChatGpt: true,
        },
      },
    },
    { authorization: `Bearer ${codexToken}` },
  );
  checks.push({
    name: "codex run_pro_prompt succeeds",
    ok:
      proPrompt.status === 200 &&
      !proPrompt.json.result?.isError &&
      proPrompt.json.result?.content?.[0]?.text.includes("codex-gptpro smoke pro ok"),
  });

  const codexProjects = await mcpPost(
    "/mcp-codex",
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "list_projects", arguments: {} },
    },
    { authorization: `Bearer ${codexToken}` },
  );
  checks.push({
    name: "codex list_projects succeeds",
    ok:
      codexProjects.status === 200 &&
      !codexProjects.json.result?.isError &&
      codexProjects.json.result?.content?.[0]?.text.includes("secondary"),
  });

  const registeredProject = await mcpPost(
    "/mcp-codex",
    {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "register_project",
        arguments: {
          projectId: "registered",
          name: "Registered",
          repoRoot: registeredRepoRoot,
        },
      },
    },
    { authorization: `Bearer ${codexToken}` },
  );
  checks.push({
    name: "codex register_project succeeds",
    ok:
      registeredProject.status === 200 &&
      !registeredProject.json.result?.isError &&
      registeredProject.json.result?.content?.[0]?.text.includes("registered"),
  });

  const registeredRead = await mcpPost("/mcp", {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: {
      name: "read_file",
      arguments: { pin: publicPin, projectId: "registered", path: "registered.txt" },
    },
  });
  checks.push({
    name: "registered project is immediately usable",
    ok:
      registeredRead.status === 200 &&
      !registeredRead.json.result?.isError &&
      registeredRead.json.result?.content?.[0]?.text.includes("from registered project"),
  });

  const exitCode = await stopServer();
  checks.push({ name: "graceful shutdown", ok: exitCode === 0 });

  const ok = checks.every((check) => check.ok);
  console.log(
    JSON.stringify({ ok, baseUrl, repoRoot, secondRepoRoot, registeredRepoRoot, checks }, null, 2),
  );
  if (!ok) {
    process.exit(1);
  }
} catch (error) {
  await stopServer().catch(() => undefined);
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        checks,
        stdout,
        stderr,
      },
      null,
      2,
    ),
  );
  process.exit(1);
}
