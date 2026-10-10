import { handleCount } from "./handle";
import { models } from "./models/runtime";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleCount(request, env, { models });
  },
} satisfies ExportedHandler<Env>;
