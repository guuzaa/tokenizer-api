import { countTokens } from "./counter";
import { createModels } from "./registry";

/** Worker pipelines. The family's tokenizer is attached here, at isolate startup. */
export const models = createModels({
  "deepseek-flash": countTokens,
});
