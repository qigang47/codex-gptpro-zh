import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { grepRepo, readFile, repoTree } from "../tools/repoTools.js";
import { makeConfig } from "./testUtils.js";

describe("repo tools", () => {
  it("reads, lists, and greps allowed text files", async () => {
    const config = makeConfig();
    fs.mkdirSync(path.join(config.repoRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(config.repoRoot, "src/example.ts"), "export const needle = 1;\n");

    expect(repoTree(config, { path: ".", depth: 1 }).tree).toContain("src/example.ts");
    expect(readFile(config, { path: "src/example.ts" }).text).toContain("needle");
    expect(await grepRepo(config, { query: "needle" })).toEqual([
      { path: "src/example.ts", line: 1, preview: "export const needle = 1;" },
    ]);
  });

  it("refuses denied file reads", () => {
    const config = makeConfig();
    fs.writeFileSync(path.join(config.repoRoot, ".env"), "SECRET=1\n");

    expect(() => readFile(config, { path: ".env" })).toThrow("denied");
  });
});
