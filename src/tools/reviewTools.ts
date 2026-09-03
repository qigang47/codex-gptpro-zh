import { z } from "zod";
import type { AppConfig } from "../core/config.js";
import { writeReview } from "../core/taskStore.js";

export const writeReviewInputSchema = {
  taskId: z.string().min(1),
  verdict: z.enum(["approved", "changes_requested", "blocked"]),
  body: z.string().min(1),
};

export function writeReviewTool(
  config: AppConfig,
  input: z.infer<z.ZodObject<typeof writeReviewInputSchema>>,
) {
  return writeReview(config.repoRoot, input);
}
