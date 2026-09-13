import path from "node:path";
import { resolveDataDir } from "./platform/paths.js";

export const DEFAULT_MAX_MODEL_ATTEMPTS = 50;
export const DEFAULT_MAX_TOTAL_TOKENS = 200_000;
export const DEFAULT_TASK_EXPIRY_MS = 30 * 60 * 1000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

export interface LatticeConfig {
  dataDir: string;
  workspace: string;
  provider: string | null;
  model: string | null;
  maxModelAttempts: number;
  maxTotalTokens: number;
  taskExpiryMs: number;
  commandTimeoutMs: number;
}

export interface ConfigInput {
  dataDir?: string | undefined;
  workspace?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  maxModelAttempts?: number | undefined;
  maxTotalTokens?: number | undefined;
  taskExpiryMs?: number | undefined;
  commandTimeoutMs?: number | undefined;
}

export function loadConfig(input: ConfigInput = {}, cwd: string = process.cwd()): LatticeConfig {
  return {
    dataDir: input.dataDir ?? resolveDataDir(),
    workspace: input.workspace ?? cwd,
    provider: input.provider ?? process.env["LATTICE_PROVIDER"] ?? null,
    model: input.model ?? process.env["LATTICE_MODEL"] ?? null,
    maxModelAttempts: input.maxModelAttempts ?? DEFAULT_MAX_MODEL_ATTEMPTS,
    maxTotalTokens: input.maxTotalTokens ?? DEFAULT_MAX_TOTAL_TOKENS,
    taskExpiryMs: input.taskExpiryMs ?? DEFAULT_TASK_EXPIRY_MS,
    commandTimeoutMs: input.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
  };
}

function positiveInt(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

export function validateConfig(config: LatticeConfig): string[] {
  const errors: string[] = [];
  if (typeof config.dataDir !== "string" || config.dataDir.trim() === "") {
    errors.push("dataDir must be a non-empty path");
  } else if (!path.isAbsolute(config.dataDir)) {
    errors.push("dataDir must be absolute");
  }
  if (typeof config.workspace !== "string" || config.workspace.trim() === "") {
    errors.push("workspace must be a non-empty path");
  } else if (!path.isAbsolute(config.workspace)) {
    errors.push("workspace must be absolute");
  }
  if (config.provider !== null && config.provider.trim() === "") {
    errors.push("provider must be null or a non-empty name");
  }
  if (config.model !== null && config.model.trim() === "") {
    errors.push("model must be null or a non-empty name");
  }
  if (!positiveInt(config.maxModelAttempts)) {
    errors.push("maxModelAttempts must be a positive integer");
  }
  if (!positiveInt(config.maxTotalTokens)) {
    errors.push("maxTotalTokens must be a positive integer");
  }
  if (!positiveInt(config.taskExpiryMs)) {
    errors.push("taskExpiryMs must be a positive integer of milliseconds");
  }
  if (!positiveInt(config.commandTimeoutMs)) {
    errors.push("commandTimeoutMs must be a positive integer of milliseconds");
  }
  return errors;
}

export function providerReadiness(config: LatticeConfig): "ready" | "provider-pending" {
  return config.provider !== null && config.model !== null ? "ready" : "provider-pending";
}
