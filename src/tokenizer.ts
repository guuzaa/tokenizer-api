import { Tokenizer } from "@huggingface/tokenizers";

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
