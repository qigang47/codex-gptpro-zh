import { z } from "zod";
import type { AppConfig } from "../core/config.js";
import { readResult, writeResult } from "../core/taskStore.js";

export const readResultInputSchema = {
  taskId: z.string().min(1),
};

export const writeResultInputSchema = {
  taskId: z.string().min(1),
  summary: z.string().min(1),
  filesChanged: z.array(z.string()).default([]),
  commandsRun: z
    .array(
      z.object({
        command: z.string().min(1),
        exitCode: z.number().int(),
        summary: z.string().min(1),
      }),
    )
    .default([]),
  remainingRisks: z.array(z.string()).optional(),
  notes: z.string().optional(),
};

export function readResultTool(
  config: AppConfig,
  input: z.infer<z.ZodObject<typeof readResultInputSchema>>,
) {
  return readResult(config.repoRoot, input.taskId);
}

export function writeResultTool(
  config: AppConfig,
  input: z.infer<z.ZodObject<typeof writeResultInputSchema>>,
) {
  return writeResult(config.repoRoot, input);
}
