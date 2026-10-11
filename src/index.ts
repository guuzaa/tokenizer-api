import { encodeMessages } from "./encoding/deepseek-v4";
import { handleCount } from "./handle";
import { MAX_PROMPT_BYTES } from "./limits";
import { countTokens } from "./models/deepseek-v4-tokenizer";
import { models } from "./models/runtime";

// The first encodes in a fresh isolate are several times the steady cost, and
// a digit run is the slowest input. Run that path during startup (1s budget)
// so a request does not pay it against the 10ms CPU limit. Global scope cannot
// read a request body, so this stays synchronous.
const warmupJson = JSON.stringify({
  model: "deepseek-v4",
  messages: [{ role: "user", content: "7".repeat(MAX_PROMPT_BYTES) }],
});
for (let attempt = 0; attempt < 4; attempt++) {
  const payload = JSON.parse(warmupJson) as { messages: { role: string; content: string }[] };
  const prompt = encodeMessages(payload.messages, { thinkingMode: "chat", dropThinking: true, addDefaultBosToken: true });
  JSON.stringify({ data: { total_tokens: countTokens(prompt) } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleCount(request, env, { models });
  },
} satisfies ExportedHandler<Env>;
