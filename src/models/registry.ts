import { deepseekFlash } from "./deepseek-flash";
import type { CountFn, Model, ModelFamily } from "./types";

/** First match wins. `deepseek-flash` is the V4.1 model id, along with every `deepseek-v4.1-*` id. */
export const modelFamilies = [deepseekFlash] as const;

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
