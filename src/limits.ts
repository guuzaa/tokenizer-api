/**
 * Reject the raw JSON body before it is parsed, and the rendered prompt before
 * tokenization. Defaults are sized for the free plan's 10ms of CPU per request.
 *
 * In workerd, `performance.now` moves in 1ms steps. The timed section is
 * synchronous (JSON parse, template render, UTF-8 length, encode, JSON
 * response), so a batch total divided by the loop count is the CPU time.
 * A run of digits is the slowest input: 8 KiB averages about 5.1ms, and a
 * single warm request stays around 6–7ms. 10 KiB averages about 6.4ms, which
 * is too close to the limit. Parsing and rendering a 48 KiB body, then
 * rejecting it before encode, is about 0.2ms.
 */
export const MAX_PROMPT_BYTES = 8 * 1024;

/**
 * Bytes the chat template adds around an empty user message. The body cap has
 * to fit a prompt of `MAX_PROMPT_BYTES` after this overhead is removed.
 */
export const PROMPT_TEMPLATE_BYTES = 66;

/**
 * Bytes of the JSON envelope outside the message content. `{"model":...,"content":""}`
 * is 65 bytes, and the two quotes around the content are not part of the envelope.
 */
export const JSON_ENVELOPE_BYTES = 63;

/** Worst-case JSON escape: one content byte becomes `\u00XX` (6 bytes). */
export const JSON_ESCAPE_BYTES_PER_CONTENT_BYTE = 6;

/** Largest prompt a var may select. Above this, wasm memory was not shown to stay under 128 MiB. */
export const ABSOLUTE_MAX_PROMPT_BYTES = 128 * 1024;

/** Smallest prompt a var may select. Below this, a normal chat no longer fits. */
export const MIN_PROMPT_BYTES = 1024;

/**
 * A configured body may sit this far above the escaping minimum so a round
 * number still validates. Further above that, a raw body would be parsed and
 * rendered before the prompt cap rejects it.
 */
export const BODY_SLACK_BYTES = 4096;

/**
 * 48 KiB. `minimumBodyBytes(MAX_PROMPT_BYTES)` is 48819; 49152 covers a
 * `\uXXXX` encoding of an 8 KiB prompt with a little room.
 */
export const MAX_BODY_BYTES = 48 * 1024;

/**
 * Retry-After on a 429. Must match `ratelimits.simple.period` in wrangler.toml.
 * The binding enforces `limit` and does not return the window.
 */
export const RATE_LIMIT_PERIOD_SECONDS = 60;

/** Smallest body that can carry `maxPromptBytes` of prompt after JSON escaping. */
export function minimumBodyBytes(maxPromptBytes: number): number {
  const contentBytes = Math.max(0, maxPromptBytes - PROMPT_TEMPLATE_BYTES);
  return JSON_ENVELOPE_BYTES + JSON_ESCAPE_BYTES_PER_CONTENT_BYTE * contentBytes;
}

export interface LimitEnv {
  MAX_BODY_BYTES?: string | number;
  MAX_PROMPT_BYTES?: string | number;
}

export interface RequestLimits {
  maxBodyBytes: number;
  maxPromptBytes: number;
}

const defaults: RequestLimits = {
  maxBodyBytes: MAX_BODY_BYTES,
  maxPromptBytes: MAX_PROMPT_BYTES,
};

function parseByteLimit(raw: string | number | undefined): number | undefined {
  if (typeof raw === "number" && Number.isSafeInteger(raw)) return raw;
  if (typeof raw === "string" && /^[0-9]+$/.test(raw)) {
    const value = Number(raw);
    if (Number.isSafeInteger(value)) return value;
  }
  return undefined;
}

function isConfigured(raw: string | number | undefined): boolean {
  return raw != null && raw !== "";
}

/**
 * Vars override the defaults. A missing pair keeps the defaults. An invalid
 * pair, or a body that cannot hold the chosen prompt, falls back to the defaults.
 */
export function resolveRequestLimits(env: LimitEnv = {}): RequestLimits {
  const promptSet = isConfigured(env.MAX_PROMPT_BYTES);
  const bodySet = isConfigured(env.MAX_BODY_BYTES);
  if (!promptSet && !bodySet) return defaults;

  const maxPromptBytes = promptSet ? parseByteLimit(env.MAX_PROMPT_BYTES) : MAX_PROMPT_BYTES;
  const minBody = maxPromptBytes == null ? undefined : minimumBodyBytes(maxPromptBytes);
  const maxBodyBytes = bodySet ? parseByteLimit(env.MAX_BODY_BYTES) : maxPromptBytes === MAX_PROMPT_BYTES ? MAX_BODY_BYTES : minBody;

  const promptOk =
    maxPromptBytes != null && maxPromptBytes >= MIN_PROMPT_BYTES && maxPromptBytes <= ABSOLUTE_MAX_PROMPT_BYTES;
  const bodyOk =
    minBody != null &&
    maxBodyBytes != null &&
    maxBodyBytes >= minBody &&
    maxBodyBytes <= minBody + BODY_SLACK_BYTES;

  if (!promptOk || !bodyOk) {
    console.error(
      JSON.stringify({
        message: "invalid request limits, using defaults",
        MAX_PROMPT_BYTES: env.MAX_PROMPT_BYTES ?? null,
        MAX_BODY_BYTES: env.MAX_BODY_BYTES ?? null,
        maxPromptBytes: defaults.maxPromptBytes,
        maxBodyBytes: defaults.maxBodyBytes,
      }),
    );
    return defaults;
  }
  return { maxBodyBytes, maxPromptBytes };
}
