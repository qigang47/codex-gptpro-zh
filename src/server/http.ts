import type http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response } from "express";
import { type AppConfig, isValidCodexAuthorization } from "../core/config.js";
import { createChatGptServer } from "./createChatGptServer.js";
import { createCodexServer } from "./createCodexServer.js";

type EndpointProfile = "chatgpt" | "codex";

function setSecurityHeaders(_request: Request, response: Response, next: () => void): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  next();
}

function localOrigins(config: AppConfig): string[] {
  return [
    `http://${config.host}:${config.port}`,
    `http://127.0.0.1:${config.port}`,
    `http://localhost:${config.port}`,
  ];
}

function validateOrigin(config: AppConfig) {
  const allowedOrigins = new Set([...localOrigins(config), ...config.allowedOrigins]);
  return (request: Request, response: Response, next: () => void): void => {
    const origin = request.header("origin");
    if (!origin || allowedOrigins.has(origin)) {
      next();
      return;
    }
    response.status(403).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Forbidden origin",
      },
      id: null,
    });
  };
}

async function handleMcpRequest(
  config: AppConfig,
  profile: EndpointProfile,
  request: Request,
  response: Response,
): Promise<void> {
  if (profile === "codex" && !isValidCodexAuthorization(config, request.header("authorization"))) {
    response.status(401).json({ error: "Unauthorized" });
    return;
  }

  const server = profile === "chatgpt" ? createChatGptServer(config) : createCodexServer(config);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  response.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  } catch (error) {
    if (!response.headersSent) {
      response.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : "Internal server error",
        },
        id: null,
      });
    }
  }
}

export function createHttpApp(config: AppConfig): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(setSecurityHeaders);
  app.use(validateOrigin(config));
  app.use(express.json({ limit: "2mb" }));

  app.get("/healthz", (_request, response) => {
    response.json({ ok: true });
  });

  app.get("/readyz", (_request, response) => {
    response.json({
      ok: true,
      service: "codex-gptpro",
      uptimeSec: Math.floor(process.uptime()),
    });
  });

  for (const method of ["get", "post"] as const) {
    app[method]("/mcp", (request, response) => {
      void handleMcpRequest(config, "chatgpt", request, response);
    });
    app[method]("/mcp-codex", (request, response) => {
      void handleMcpRequest(config, "codex", request, response);
    });
  }

  app.all(["/mcp", "/mcp-codex"], (_request, response) => {
    response.setHeader("Allow", "GET, POST");
    response.status(405).json({ error: "Method not allowed" });
  });

  return app;
}

export function startHttpServer(config: AppConfig): Promise<http.Server> {
  const app = createHttpApp(config);
  return new Promise((resolve, reject) => {
    const server = app.listen(config.port, config.host, () => {
      console.log(`codex-gptpro listening on http://${config.host}:${config.port}`);
      resolve(server);
    });
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;
    server.requestTimeout = 120_000;
    server.on("error", reject);
  });
}
