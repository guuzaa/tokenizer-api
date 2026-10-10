import { Tokenizer } from "@huggingface/tokenizers";
import tokenizerConfig from "../config/deepseek-v4/tokenizer_config.json";
import tokenizerJson from "../config/deepseek-v4/tokenizer.json";

export interface TokenCounter {
  encodeIds(text: string): number[];
  countTokens(text: string): number;
}

/** Build a counter from a Hugging Face tokenizer.json and tokenizer_config.json. */
export function createTokenCounter(json: Record<string, unknown>, config: Record<string, unknown>): TokenCounter {
  const tokenizer = new Tokenizer(json, config);
  const encodeIds = (text: string): number[] => tokenizer.encode(text, { add_special_tokens: false }).ids;
  return {
    encodeIds,
    countTokens(text: string): number {
      return encodeIds(text).length;
    },
  };
}

const deepseekV4 = createTokenCounter(tokenizerJson, tokenizerConfig);

export function encodeIds(text: string): number[] {
  return deepseekV4.encodeIds(text);
}

export function countTokens(text: string): number {
  return deepseekV4.countTokens(text);
}
