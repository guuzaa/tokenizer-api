import { encodeMessages, EncodeError, type ChatMessage, type ReasoningEffort, type ThinkingMode } from "./encoding/deepseek-v4";
import { MAX_BODY_BYTES, MAX_PROMPT_BYTES } from "./limits";

export type CountFn = (text: string) => number;

const encoder = new TextEncoder();

function json(body: unknown, status: number, extraHeaders?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

function error(status: number, message: string, type: string): Response {
  return json({ error: { message, type } }, status);
}

function isDeepseekV4Model(model: string): boolean {
  return model === "deepseek-v4" || model.startsWith("deepseek-v4-");
}

async function readBody(request: Request): Promise<Uint8Array | "too_large" | "invalid_length"> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) return "invalid_length";
    if (Number(declared) > MAX_BODY_BYTES) return "too_large";
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return "too_large";
    }
    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function assertTextMessages(messages: ChatMessage[]): void {
  messages.forEach((message, index) => {
    if (message == null || typeof message !== "object" || Array.isArray(message)) {
      throw new EncodeError(`message ${index} must be an object`);
    }
    if (message.role === "tool") return;
    if (message.content != null && typeof message.content !== "string") {
      throw new EncodeError(`message ${index} content must be a string`);
    }
  });
}

function readOptions(body: Record<string, unknown>): {
  thinkingMode: ThinkingMode;
  dropThinking: boolean;
  addDefaultBosToken: boolean;
  reasoningEffort: ReasoningEffort | null;
} {
  const thinkingMode = body.thinking_mode ?? "chat";
  if (thinkingMode !== "chat" && thinkingMode !== "thinking") {
    throw new EncodeError("thinking_mode must be \"chat\" or \"thinking\"");
  }
  if (body.drop_thinking != null && typeof body.drop_thinking !== "boolean") {
    throw new EncodeError("drop_thinking must be a boolean");
  }
  if (body.add_default_bos_token != null && typeof body.add_default_bos_token !== "boolean") {
    throw new EncodeError("add_default_bos_token must be a boolean");
  }
  const reasoningEffort = body.reasoning_effort ?? null;
  if (reasoningEffort != null && reasoningEffort !== "max" && reasoningEffort !== "high") {
    throw new EncodeError("reasoning_effort must be \"max\", \"high\", or null");
  }
  return {
    thinkingMode,
    dropThinking: typeof body.drop_thinking === "boolean" ? body.drop_thinking : true,
    addDefaultBosToken: typeof body.add_default_bos_token === "boolean" ? body.add_default_bos_token : true,
    reasoningEffort,
  };
}

export async function handleCount(request: Request, countTokens: CountFn): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/v1/token/count") {
    return error(404, "not found", "not_found");
  }
  if (request.method !== "POST") {
    return error(405, "method not allowed", "method_not_allowed", );
  }

  const bodyBytes = await readBody(request);
  if (bodyBytes === "invalid_length") return error(400, "invalid content-length", "invalid_request_error");
  if (bodyBytes === "too_large") {
    return error(413, `request body exceeds ${MAX_BODY_BYTES} bytes`, "request_too_large");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch {
    return error(400, "invalid JSON body", "invalid_request_error");
  }
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
    return error(400, "body must be a JSON object", "invalid_request_error");
  }
  const body = payload as Record<string, unknown>;
  if (typeof body.model !== "string" || body.model.length === 0) {
    return error(400, "model is required", "invalid_request_error");
  }
  if (!isDeepseekV4Model(body.model)) {
    return error(400, `unsupported model: ${body.model}`, "invalid_request_error");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return error(400, "messages must be a non-empty array", "invalid_request_error");
  }

  let prompt: string;
  try {
    assertTextMessages(body.messages as ChatMessage[]);
    const options = readOptions(body);
    prompt = encodeMessages(body.messages as ChatMessage[], options);
  } catch (err) {
    if (err instanceof EncodeError) return error(400, err.message, "invalid_request_error");
    console.error(JSON.stringify({ message: "token count failed", error: err instanceof Error ? err.message : String(err) }));
    return error(500, "failed to render prompt", "internal_error");
  }

  if (encoder.encode(prompt).byteLength > MAX_PROMPT_BYTES) {
    return error(413, `rendered prompt exceeds ${MAX_PROMPT_BYTES} bytes`, "request_too_large");
  }

  try {
    const totalTokens = countTokens(prompt);
    return json({ data: { total_tokens: totalTokens } }, 200);
  } catch (err) {
    console.error(JSON.stringify({ message: "token count failed", error: err instanceof Error ? err.message : String(err) }));
    return error(500, "failed to count tokens", "internal_error");
  }
}
