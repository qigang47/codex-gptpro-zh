import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isValidCodexAuthorization, loadConfig, validatePublicPin } from "../core/config.js";
import { makeTempRepo } from "./testUtils.js";

describe("config", () => {
  it("starts without required env or registered projects", () => {
    const config = loadConfig({});

    expect(config.repoRoot).toBe(process.cwd());
    expect(config.defaultProjectId).toBe("");
    expect(config.projects).toEqual([]);
    expect(config.publicPin).toBeUndefined();
    expect(config.codexToken).toBeUndefined();
    expect(() => validatePublicPin(config, "")).not.toThrow();
    expect(isValidCodexAuthorization(config, undefined)).toBe(true);
  });

  it("loads optional project registry and auth values", () => {
    const repoRoot = makeTempRepo();
    const projectsFile = path.join(os.tmpdir(), `codex-gptpro-projects-${Date.now()}.json`);
    fs.writeFileSync(
      projectsFile,
      JSON.stringify({
        defaultProjectId: "default",
        projects: [{ id: "default", name: "default", repoRoot }],
      }),
    );
    const config = loadConfig({
      MCP_PROJECTS_FILE: projectsFile,
      MCP_PUBLIC_PIN: "pin",
      MCP_CODEX_TOKEN: "token",
    });

    expect(config.repoRoot).toBe(repoRoot);
    expect(config.defaultProjectId).toBe("default");
    expect(config.projects).toEqual([{ id: "default", name: "default", repoRoot }]);
    expect(() => validatePublicPin(config, "pin")).not.toThrow();
    expect(() => validatePublicPin(config, "wrong")).toThrow("Invalid MCP public PIN");
    expect(isValidCodexAuthorization(config, "Bearer token")).toBe(true);
    expect(isValidCodexAuthorization(config, "Bearer wrong")).toBe(false);
  });

  it("loads multiple projects from MCP_PROJECTS_FILE", () => {
    const firstRepoRoot = makeTempRepo();
    const secondRepoRoot = makeTempRepo();
    const projectsFile = path.join(os.tmpdir(), `codex-gptpro-projects-${Date.now()}.json`);
    fs.writeFileSync(
      projectsFile,
      JSON.stringify(
        {
          defaultProjectId: "second",
          projects: [
            { id: "first", name: "First", repoRoot: firstRepoRoot },
            { id: "second", name: "Second", repoRoot: secondRepoRoot },
          ],
        },
        null,
        2,
      ),
    );

    const config = loadConfig({
      MCP_PROJECTS_FILE: projectsFile,
      MCP_PUBLIC_PIN: "pin",
      MCP_CODEX_TOKEN: "token",
    });

    expect(config.defaultProjectId).toBe("second");
    expect(config.repoRoot).toBe(secondRepoRoot);
    expect(config.projects.map((project) => project.id)).toEqual(["first", "second"]);
  });

  it("rejects missing registered project roots instead of creating them", () => {
    const projectsFile = path.join(os.tmpdir(), `codex-gptpro-projects-missing-${Date.now()}.json`);
    fs.writeFileSync(
      projectsFile,
      JSON.stringify({
        defaultProjectId: "missing",
        projects: [
          {
            id: "missing",
            name: "Missing",
            repoRoot: "/tmp/codex-gptpro-does-not-exist",
          },
        ],
      }),
    );

    expect(() =>
      loadConfig({
        MCP_PROJECTS_FILE: projectsFile,
      }),
    ).toThrow("repoRoot must exist");
  });
});
