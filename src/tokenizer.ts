import { Tokenizer } from "@huggingface/tokenizers";
import tokenizerConfig from "../config/deepseek-v4/tokenizer_config.json";
import tokenizerJson from "../config/deepseek-v4/tokenizer.json";

const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);

export function encodeIds(text: string): number[] {
  return tokenizer.encode(text, { add_special_tokens: false }).ids;
}

export function countTokens(text: string): number {
  return encodeIds(text).length;
}
