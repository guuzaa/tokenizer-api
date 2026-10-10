import { handleCount } from "./handle";
import { countTokens } from "./tokenizer";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleCount(request, countTokens, env);
  },
} satisfies ExportedHandler<Env>;
