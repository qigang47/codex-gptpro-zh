import { describe, expect, it } from "vitest";
import { claimTask, createTask, listTasks, writeResult } from "../core/taskStore.js";
import { makeTempRepo } from "./testUtils.js";

describe("taskStore", () => {
  it("creates unique task ids for duplicate titles in the same second", () => {
    const repoRoot = makeTempRepo();
    const first = createTask(repoRoot, {
      title: "Implement OAuth TODO",
      objective: "one",
      acceptanceCriteria: ["done"],
    });
    const second = createTask(repoRoot, {
      title: "Implement OAuth TODO",
      objective: "two",
      acceptanceCriteria: ["done"],
    });

    expect(second.taskId).not.toBe(first.taskId);
    expect(listTasks(repoRoot)).toHaveLength(2);
  });

  it("does not let another actor steal an already claimed task", () => {
    const repoRoot = makeTempRepo();
    const task = createTask(repoRoot, {
      title: "Claim me",
      objective: "claim",
      acceptanceCriteria: ["claimed"],
    });

    const first = claimTask(repoRoot, task.taskId, "codex");
    const second = claimTask(repoRoot, task.taskId, "other");

    expect(first.claimedBy).toBe("codex");
    expect(second.claimedBy).toBe("codex");
  });

  it("writeResult marks the task done", () => {
    const repoRoot = makeTempRepo();
    const task = createTask(repoRoot, {
      title: "Finish me",
      objective: "finish",
      acceptanceCriteria: ["done"],
    });

    writeResult(repoRoot, {
      taskId: task.taskId,
      summary: "done",
      filesChanged: ["src/index.ts"],
      commandsRun: [{ command: "pnpm test", exitCode: 0, summary: "passed" }],
    });

    expect(listTasks(repoRoot)[0]?.status).toBe("done");
  });
});
