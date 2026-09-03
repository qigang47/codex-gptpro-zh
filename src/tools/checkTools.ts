import { z } from "zod";
import { runPackageCheck } from "../core/commandRunner.js";
import type { AppConfig } from "../core/config.js";

export const runCheckInputSchema = {
  name: z.enum(["typecheck", "lint", "test", "build"]),
  timeoutSec: z.number().int().positive().max(600).optional(),
};

export async function runCheckTool(
  config: AppConfig,
  input: z.infer<z.ZodObject<typeof runCheckInputSchema>>,
) {
  return runPackageCheck(config.repoRoot, input.name, input.timeoutSec);
}
