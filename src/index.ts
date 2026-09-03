import { loadConfig } from "./core/config.js";
import { ensureProjectWorkspaces } from "./core/projects.js";
import { startHttpServer } from "./server/http.js";

const config = loadConfig();
ensureProjectWorkspaces(config);
const server = await startHttpServer(config);

let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`codex-gptpro received ${signal}; shutting down`);
  const forceExitTimer = setTimeout(() => {
    console.error("codex-gptpro shutdown timed out");
    process.exit(1);
  }, 10_000);
  forceExitTimer.unref();

  server.close((error) => {
    if (error) {
      console.error("codex-gptpro shutdown failed", error);
      process.exit(1);
    }
    console.log("codex-gptpro stopped");
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

process.on("uncaughtException", (error) => {
  console.error("codex-gptpro uncaught exception", error);
  shutdown("SIGTERM");
});

process.on("unhandledRejection", (reason) => {
  console.error("codex-gptpro unhandled rejection", reason);
  shutdown("SIGTERM");
});
