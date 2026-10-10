import { handleCount } from "./handle";
import { countTokens } from "./tokenizer";

export default {
  async fetch(request: Request): Promise<Response> {
    return handleCount(request, countTokens);
  },
} satisfies ExportedHandler;
