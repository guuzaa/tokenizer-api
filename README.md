# tokenizer-api

Count tokens for DeepSeek V4 chat messages.

The worker renders messages in the DeepSeek V4 prompt format, then counts tokens with the model tokenizer.

## API

`POST /v1/token/count`

```bash
curl http://localhost:8787/v1/token/count \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4",
    "messages": [
      { "role": "system", "content": "You are a helpful assistant." },
      { "role": "user", "content": "Hello" }
    ]
  }'
```

```json
{ "data": { "total_tokens": 11 } }
```

`model` must be `deepseek-v4` or start with `deepseek-v4-`. Every accepted name uses this same tokenizer and chat template.

### Messages

`messages` is a non-empty array. `content` is text.

`tools` on a message is an OpenAI tool list (`{ "type": "function", "function": { ... } }`). The schemas are written into the prompt.

`tool_calls` on an assistant message is an OpenAI tool-call list. A `role: "tool"` message (`tool_call_id` plus string `content`) is merged into a user turn as a `<tool_result>` block. Tool `content` must be a string, or a list of content blocks. Objects, numbers, booleans, and null are rejected: the official encoder prints those with Python's `repr`, and a JSON body cannot reproduce that exactly (`22.0` and `22` are the same number after parsing).

`reasoning_content` on an assistant message is that turn's thinking text.

Other roles: `system`, `developer`, `user`, `assistant`, and `latest_reminder`.

### Options

`thinking_mode` is `chat` (default) or `thinking`. Chat closes the turn with `</think>`. Thinking closes it with `<think>`.

`drop_thinking` defaults to `true`. In thinking mode, `reasoning_content` on assistant turns before the last user message is left out of the prompt. If any message has `tools`, thinking is kept.

`add_default_bos_token` defaults to `true`. It prepends the BOS token at the start of the conversation.

`reasoning_effort` is `max`, `high`, or `null` (default). In thinking mode, `max` prepends the "Absolute maximum..." instruction. `high` is accepted and adds nothing. That matches current DeepSeek V4 Pro and Flash. It does not match the older Flash-0731 template, where `high` and `max` are different prefixes.

### Limits

The free-plan defaults keep a worst-case request under the 10 ms CPU limit. The raw JSON body must be at most 48 KiB (`49152` bytes). The rendered prompt must be at most 8 KiB (`8192` bytes). Over either cap, the response is 413 `request_too_large`, and the tokenizer does not run. A body over the cap is rejected before `JSON.parse`. A prompt over the cap is rejected after the template is rendered and before tokenization.

A long run of digits is the slowest input measured in workerd. At 8 KiB that request averages about 5 ms and a single warm request stays around 6–7 ms. The next sizes measured, 10 KiB and up, do not leave enough room under 10 ms. The body cap is the size of that prompt written with `\uXXXX` escapes, plus the JSON envelope and the chat-template overhead (66 bytes around an empty user message).

Both caps are [vars](https://developers.cloudflare.com/workers/wrangler/configuration/#vars). A positive integer replaces that default. An unset or invalid value leaves its default in place. The two settings are independent.

Wasm memory stays about 58 MiB through an 8 KiB prompt and about 62 MiB at 128 KiB. A 1 MiB prompt with no whitespace grew it to about 133 MiB, past the 128 MiB isolate limit, so keep a paid prompt at or below 128 KiB.

On the Workers Paid plan the default CPU limit is 30 seconds and `limits.cpu_ms` can raise it up to 5 minutes. Do not set `limits.cpu_ms` on the free plan; that configuration is rejected. A 128 KiB digit run measured about 90 ms (max 95 ms) in workerd. A paid deploy can raise the caps and set the CPU limit above that measurement:

```toml
[vars]
MAX_PROMPT_BYTES = "131072"
MAX_BODY_BYTES = "786432"

[limits]
cpu_ms = 200
```

`786432` is 768 KiB, enough for a `\uXXXX` encoding of a 128 KiB prompt. The isolate encodes a max-size digit run four times at startup so the first request does not pay the one-time cost. That stays inside the 1 second startup limit.

### Errors

```json
{ "error": { "message": "messages must be a non-empty array", "type": "invalid_request_error" } }
```

| Status | `type` |
| --- | --- |
| 400 | `invalid_request_error` |
| 401 | `authentication_error` |
| 404 | `not_found` |
| 405 | `method_not_allowed` |
| 413 | `request_too_large` |
| 429 | `rate_limit_error` |
| 500 | `internal_error` |

A 429 includes `Retry-After: 60`.

An unpaired UTF-16 surrogate in the rendered prompt is 400. The counter is the Rust `tokenizers` crate, and a Rust string cannot hold that value. Well-formed text, including emoji, is counted.

### Tokenizer

Counts use the Hugging Face [`tokenizers`](https://github.com/huggingface/tokenizers) crate (0.23) compiled to `wasm32-unknown-unknown`. The build turns default features off and enables `unstable_wasm`, so regular expressions use `fancy-regex` rather than the C `onig` library. `config/deepseek-v4/tokenizer.json` is embedded in the wasm module. Special tokens are not added during encode; the chat template writes them into the prompt.

The wasm module is built, not committed. `pnpm test`, `pnpm check`, `pnpm dev`, and `pnpm deploy` run that build first.

### Access

The endpoint is public unless the `API_KEYS` secret is set.

Each caller may send 60 requests per 60 seconds. The [Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) enforces that per Cloudflare location, not as one global counter. Public requests are keyed on `CF-Connecting-IP`. Requests with no such header share an `unknown` bucket. A request with a valid API key is keyed on a hash of that key, so callers behind one shared IP are not mixed together.

To require a key, set `API_KEYS` to a comma-separated list of bearer tokens. Do not commit the value.

```bash
wrangler secret put API_KEYS
```

Then send `Authorization: Bearer <token>`. A missing or unknown token is 401. With no `API_KEYS` secret, the endpoint stays public. The limit and the binding name are in `wrangler.toml`.

## Develop

```bash
pnpm install
pnpm dev
pnpm test
pnpm check
```

Installs use `registry.npmjs.org` (`.npmrc`). The package manager is pnpm 12 (`packageManager` in `package.json`).

`pnpm test` runs the node tests and the workerd tests (`@cloudflare/vitest-plugin`). Those commands need Rust, the `wasm32-unknown-unknown` target, and `wasm-bindgen` 0.2.129. `scripts/build-wasm.sh` installs that `wasm-bindgen` release if it is missing. CI installs the Rust toolchain before the tests.
