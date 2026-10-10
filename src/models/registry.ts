import { deepseekV4 } from "./deepseek-v4";
import type { CountFn, Model, ModelFamily } from "./types";

/**
 * First match wins. `deepseek-v4` accepts `deepseek-v4` and every `deepseek-v4-*`
 * id, so it stays last. Register DeepSeek V4.1 Flash above it, with its own
 * encoder, tokenizer, options, and prompt cap. An id under the `deepseek-v4-`
 * prefix is counted as V4 unless an earlier family claims it.
 */
export const modelFamilies = [deepseekV4] as const;

type FamilyName = (typeof modelFamilies)[number]["name"];

export function createModels(counters: Record<FamilyName, CountFn>): Model[] {
  return modelFamilies.map((family) => ({
    ...family,
    countTokens: counters[family.name],
  }));
}

export function resolveModel<T extends ModelFamily>(model: string, models: readonly T[]): T | undefined {
  return models.find((candidate) => candidate.matches(model));
}
