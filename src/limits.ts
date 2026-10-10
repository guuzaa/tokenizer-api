/**
 * Reject the raw JSON body before it is parsed. Kept near the prompt cap so
 * `JSON.parse` itself cannot spend the free-plan 10ms budget.
 */
export const MAX_BODY_BYTES = 16 * 1024;

/**
 * Reject the rendered prompt before BPE.
 * Local medians after warmup (Bun, this machine): 4 KiB of repeated ASCII
 * encodes in about 3ms; 8 KiB in about 5ms, with spikes over 10ms. Cloudflare
 * CPUs are slower, so 4 KiB is the cap that still leaves room under 10ms.
 */
export const MAX_PROMPT_BYTES = 4 * 1024;

/**
 * Retry-After on a 429. Must match `ratelimits.simple.period` in wrangler.toml.
 * The binding enforces `limit` and does not return the window.
 */
export const RATE_LIMIT_PERIOD_SECONDS = 60;
