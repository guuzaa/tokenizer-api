import { createTokenCounter, tokenizerInitMs } from "../tokenizer";

export const { encodeIds, countTokens } = createTokenCounter();
export { tokenizerInitMs };
