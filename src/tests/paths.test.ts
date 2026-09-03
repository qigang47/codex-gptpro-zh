import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureRepoWorkspace, resolveSafePath } from "../core/paths.js";
import { makeTempRepo } from "./testUtils.js";

describe("paths", () => {
  it("blocks traversal and denied files", () => {
    const repoRoot = makeTempRepo();
    fs.writeFileSync(path.join(repoRoot, ".env"), "SECRET=1\n");

    expect(() => resolveSafePath(repoRoot, "../outside")).toThrow("escapes repository root");
    expect(() => resolveSafePath(repoRoot, ".env")).toThrow("denied");
  });

  it("blocks symlink escapes", () => {
    const repoRoot = makeTempRepo();
    const outside = fs.mkdtempSync(path.join(repoRoot, "..", "outside-"));
    fs.writeFileSync(path.join(outside, "file.txt"), "outside");
    fs.symlinkSync(path.join(outside, "file.txt"), path.join(repoRoot, "link.txt"));

    expect(() => resolveSafePath(repoRoot, "link.txt")).toThrow("outside repository root");
  });

  it("does not create a missing repository root", () => {
    const missing = path.join(makeTempRepo(), "missing");
    expect(() => ensureRepoWorkspace(missing)).toThrow("Repository root must exist");
    expect(fs.existsSync(missing)).toBe(false);
  });
});
