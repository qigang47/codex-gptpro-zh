import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { sanitizeAuditError } from "./sanitize.js";

export type AuditProfile = "chatgpt" | "codex";

type AuditEntry = {
  timestamp: string;
  profile: AuditProfile;
  tool: string;
  success: boolean;
  durationMs: number;
  error: string | null;
};

export async function withAudit<T>(
  config: AppConfig,
  profile: AuditProfile,
  tool: string,
  run: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await run();
    appendAudit(config, {
      timestamp: new Date().toISOString(),
      profile,
      tool,
      success: true,
      durationMs: Date.now() - started,
      error: null,
    });
    return result;
  } catch (error) {
    appendAudit(config, {
      timestamp: new Date().toISOString(),
      profile,
      tool,
      success: false,
      durationMs: Date.now() - started,
      error: sanitizeAuditError(error),
    });
    throw error;
  }
}

function appendAudit(config: AppConfig, entry: AuditEntry): void {
  const logPath = path.join(config.repoRoot, ".ai/logs/mcp-audit.jsonl");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8");
}
