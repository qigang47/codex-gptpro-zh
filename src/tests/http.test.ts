import type http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpApp } from "../server/http.js";
import { makeConfig } from "./testUtils.js";

let server: http.Server | undefined;

async function startTestServer(config = makeConfig()) {
  const app = createHttpApp(config);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server?.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing test server address");
  }
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  if (!server) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server?.close((error) => (error ? reject(error) : resolve()));
  });
  server = undefined;
});

describe("http", () => {
  it("sets security headers and healthz", async () => {
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/healthz`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.json()).toEqual({ ok: true });
  });

  it("returns readiness status", async () => {
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/readyz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      service: "codex-gptpro",
    });
  });

  it("rejects invalid browser origins", async () => {
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/healthz`, {
      headers: { origin: "https://example.invalid" },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { message: "Forbidden origin" },
    });
  });

  it("allows configured browser origins", async () => {
    const config = makeConfig();
    config.allowedOrigins = ["https://allowed.example"];
    const baseUrl = await startTestServer(config);
    const response = await fetch(`${baseUrl}/healthz`, {
      headers: { origin: "https://allowed.example" },
    });

    expect(response.status).toBe(200);
  });

  it("requires bearer auth for /mcp-codex", async () => {
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/mcp-codex`);

    expect(response.status).toBe(401);
  });

  it("allows /mcp-codex without auth when no token is configured", async () => {
    const config = makeConfig();
    config.codexToken = undefined;
    const baseUrl = await startTestServer(config);
    const response = await fetch(`${baseUrl}/mcp-codex`);

    expect(response.status).not.toBe(401);
  });

  it("rejects unsupported MCP methods", async () => {
    const baseUrl = await startTestServer();
    const response = await fetch(`${baseUrl}/mcp`, { method: "PUT" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, POST");
  });
});
