/** Rendered prompt cap. Keeps a worst-case request under the free plan's 10ms CPU limit. */
export const MAX_PROMPT_BYTES = 8 * 1024;

/** Raw JSON body cap. Covers an 8 KiB prompt after JSON escaping and template overhead. */
export const MAX_BODY_BYTES = 48 * 1024;

/**
 * Retry-After on a 429. Must match `ratelimits.simple.period` in wrangler.toml.
 * The binding enforces `limit` and does not return the window.
 */
export const RATE_LIMIT_PERIOD_SECONDS = 60;

/** A positive integer var replaces that default. Anything else leaves the default. */
export function requestLimits(env: { MAX_PROMPT_BYTES?: string | number; MAX_BODY_BYTES?: string | number } = {}) {
  const limit = (raw: string | number | undefined, fallback: number) => {
    const value = Number(raw);
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  };
  return {
    maxPromptBytes: limit(env.MAX_PROMPT_BYTES, MAX_PROMPT_BYTES),
    maxBodyBytes: limit(env.MAX_BODY_BYTES, MAX_BODY_BYTES),
  };
}
