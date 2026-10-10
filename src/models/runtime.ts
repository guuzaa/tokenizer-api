import { countTokens } from "./deepseek-v4-tokenizer";
import { createModels } from "./registry";

/** Worker pipelines. Each family's tokenizer is attached here, at isolate startup. */
export const models = createModels({
  "deepseek-v4": countTokens,
});
