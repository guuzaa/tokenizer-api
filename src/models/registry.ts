import { deepseekFlash } from "./deepseek-flash";
import { deepseekV4 } from "./deepseek-v4";
import type { CountFn, Model, ModelFamily } from "./types";

/**
 * First match wins. `deepseek-flash` is the exact V4.1 model id.
 * `deepseek-v4` accepts `deepseek-v4` and every `deepseek-v4-*` id, so it stays last.
 * An id under the `deepseek-v4-` prefix is counted as V4 unless an earlier family claims it.
 */
export const modelFamilies = [deepseekFlash, deepseekV4] as const;

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
