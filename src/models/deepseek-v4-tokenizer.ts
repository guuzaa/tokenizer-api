import tokenizerConfig from "../../config/deepseek-v4/tokenizer_config.json";
import tokenizerJson from "../../config/deepseek-v4/tokenizer.json";
import { createTokenCounter } from "../tokenizer";

export const { encodeIds, countTokens } = createTokenCounter(tokenizerJson, tokenizerConfig);
