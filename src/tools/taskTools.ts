import { z } from "zod";
import type { AppConfig } from "../core/config.js";
import {
  claimTask,
  createTask,
  listTasks,
  prioritySchema,
  readTask,
  taskStatusSchema,
} from "../core/taskStore.js";

export const createTaskInputSchema = {
  title: z.string().min(1),
  objective: z.string().min(1),
  context: z.string().optional(),
  relevantFiles: z.array(z.string()).optional(),
  constraints: z.array(z.string()).optional(),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  verificationCommands: z.array(z.string()).optional(),
  priority: prioritySchema.optional(),
};

export const listTasksInputSchema = {
  status: taskStatusSchema.optional(),
};

export const readTaskInputSchema = {
  taskId: z.string().min(1),
};

export const claimTaskInputSchema = {
  taskId: z.string().min(1),
  actor: z.string().min(1).optional(),
};

export function createTaskTool(
  config: AppConfig,
  input: z.infer<z.ZodObject<typeof createTaskInputSchema>>,
) {
  return createTask(config.repoRoot, input);
}

export function listTasksTool(
  config: AppConfig,
  input: z.infer<z.ZodObject<typeof listTasksInputSchema>>,
) {
  return listTasks(config.repoRoot, input.status);
}

export function readTaskTool(
  config: AppConfig,
  input: z.infer<z.ZodObject<typeof readTaskInputSchema>>,
) {
  return readTask(config.repoRoot, input.taskId);
}

export function claimTaskTool(
  config: AppConfig,
  input: z.infer<z.ZodObject<typeof claimTaskInputSchema>>,
) {
  return claimTask(config.repoRoot, input.taskId, input.actor ?? "codex");
}
