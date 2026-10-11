import wasmModule from "../tokenizer-wasm/pkg/tokenizer_wasm_bg.wasm";
import { count_tokens, encode_ids, initSync } from "../tokenizer-wasm/pkg/tokenizer_wasm.js";

export class TokenizerInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenizerInputError";
  }
}

export interface TokenCounter {
  encodeIds(text: string): number[];
  countTokens(text: string): number;
}

let counter: TokenCounter | undefined;

function assertWellFormed(text: string): void {
  if (!isWellFormed(text)) throw new TokenizerInputError("text contains an unpaired surrogate");
}

function isWellFormed(text: string): boolean {
  const check = (text as { isWellFormed?: () => boolean }).isWellFormed;
  if (typeof check === "function") return check.call(text);
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0xd800 || code > 0xdfff) continue;
    const next = text.charCodeAt(index + 1);
    if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      index++;
      continue;
    }
    return false;
  }
  return true;
}

function buildCounter(): TokenCounter {
  initSync({ module: wasmModule });
  return {
    encodeIds(text: string): number[] {
      assertWellFormed(text);
      return Array.from(encode_ids(text));
    },
    countTokens(text: string): number {
      assertWellFormed(text);
      return count_tokens(text);
    },
  };
}

/**
 * DeepSeek V4 token counter.
 * The vocab is the Hugging Face `tokenizers` crate (fancy-regex, no onig) compiled into
 * `tokenizer-wasm/pkg`, with `config/deepseek-v4/tokenizer.json` embedded at build time.
 */
export function createTokenCounter(): TokenCounter {
  counter ??= buildCounter();
  return counter;
}
