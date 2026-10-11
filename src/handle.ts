import { EncodeError } from "./encoding/shared";
import { TokenizerInputError } from "./tokenizer";
import { RATE_LIMIT_PERIOD_SECONDS, requestLimits } from "./limits";
import { modelFamilies, resolveModel } from "./models/registry";
import type { CountFn, Model, ModelFamily } from "./models/types";

export type { CountFn };

export interface CountEnv {
  RATE_LIMITER?: RateLimit;
  /** Comma-separated bearer tokens. When unset or empty, the endpoint is public. */
  API_KEYS?: string;
  MAX_BODY_BYTES?: string | number;
  MAX_PROMPT_BYTES?: string | number;
}

const encoder = new TextEncoder();

function json(body: unknown, status: number, extraHeaders?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

function error(status: number, message: string, type: string, extraHeaders?: HeadersInit): Response {
  return json({ error: { message, type } }, status, extraHeaders);
}

function configuredApiKeys(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").map((key) => key.trim()).filter((key) => key.length > 0);
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

async function tokenMatches(token: string, keys: string[]): Promise<boolean> {
  const given = await sha256(token);
  let matched = false;
  for (const key of keys) {
    if (equalBytes(given, await sha256(key))) matched = true;
  }
  return matched;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function rateLimitKey(request: Request, authedToken: string | null): Promise<string> {
  if (authedToken) return `key:${hex(await sha256(authedToken))}`;
  const ip = request.headers.get("CF-Connecting-IP");
  return `ip:${ip && ip.length > 0 ? ip : "unknown"}`;
}

async function enforceAccess(request: Request, env: CountEnv): Promise<Response | null> {
  const keys = configuredApiKeys(env.API_KEYS);
  const presented = bearerToken(request);
  const authed = keys.length > 0 && presented && (await tokenMatches(presented, keys)) ? presented : null;

  if (env.RATE_LIMITER) {
    const { success } = await env.RATE_LIMITER.limit({ key: await rateLimitKey(request, authed) });
    if (!success) {
      return error(429, "rate limit exceeded", "rate_limit_error", {
        "retry-after": String(RATE_LIMIT_PERIOD_SECONDS),
      });
    }
  }

  if (keys.length > 0 && !authed) return error(401, "invalid api key", "authentication_error");
  return null;
}

async function readBody(request: Request, maxBodyBytes: number): Promise<Uint8Array | "too_large" | "invalid_length"> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) return "invalid_length";
    if (Number(declared) > maxBodyBytes) return "too_large";
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
    if (total > maxBodyBytes) {
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

export interface HandleOptions {
  /** Wired families. The worker passes these from `src/models/runtime.ts`. */
  models?: readonly Model[];
  /** Replaces the matched model's counter. Unit tests use this so they do not load a tokenizer. */
  countTokens?: CountFn;
}

function counterFor(model: ModelFamily | Model, override?: CountFn): CountFn {
  if (override) return override;
  if ("countTokens" in model) return model.countTokens;
  throw new Error(`${model.name} tokenizer is not configured`);
}

export async function handleCount(request: Request, env: CountEnv = {}, options?: HandleOptions): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/v1/token/count") {
    return error(404, "not found", "not_found");
  }
  if (request.method !== "POST") {
    return error(405, "method not allowed", "method_not_allowed", );
  }

  const denied = await enforceAccess(request, env);
  if (denied) return denied;

  const limits = requestLimits(env);
  const bodyBytes = await readBody(request, limits.maxBodyBytes);
  if (bodyBytes === "invalid_length") return error(400, "invalid content-length", "invalid_request_error");
  if (bodyBytes === "too_large") {
    return error(413, `request body exceeds ${limits.maxBodyBytes} bytes`, "request_too_large");
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
  const model = resolveModel(body.model, options?.models ?? modelFamilies);
  if (!model) return error(400, `unsupported model: ${body.model}`, "invalid_request_error");

  let prompt: string;
  try {
    prompt = model.render(body);
  } catch (err) {
    if (err instanceof EncodeError) return error(400, err.message, "invalid_request_error");
    console.error(JSON.stringify({ message: "token count failed", error: err instanceof Error ? err.message : String(err) }));
    return error(500, "failed to render prompt", "internal_error");
  }

  if (encoder.encode(prompt).byteLength > limits.maxPromptBytes) {
    return error(413, `rendered prompt exceeds ${limits.maxPromptBytes} bytes`, "request_too_large");
  }

  try {
    const totalTokens = counterFor(model, options?.countTokens)(prompt);
    return json({ data: { total_tokens: totalTokens } }, 200);
  } catch (err) {
    if (err instanceof TokenizerInputError) return error(400, err.message, "invalid_request_error");
    console.error(JSON.stringify({ message: "token count failed", error: err instanceof Error ? err.message : String(err) }));
    return error(500, "failed to count tokens", "internal_error");
  }
}
