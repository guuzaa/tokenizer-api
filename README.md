# tokenizer-api

Count tokens for DeepSeek V4.1 chat messages.

The worker renders messages with the V4.1 chat template, then counts tokens with the model tokenizer.

## API

`POST /v1/token/count`

```bash
curl http://localhost:8787/v1/token/count \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-flash",
    "thinking_mode": "chat",
    "messages": [
      { "role": "system", "content": "You are a helpful assistant." },
      { "role": "user", "content": "Hello" }
    ]
  }'
```

```json
{ "data": { "total_tokens": 12 } }
```

`deepseek-flash`, and any name starting with `deepseek-v4.1-`, uses this encoder. `deepseek-v4.1-flash` is one of those names. The example above is chat mode; omit `thinking_mode` and the default is thinking, which counts more tokens because the prompt includes a reasoning-effort line.

### Messages

`messages` is a non-empty array. `content` is a string or a list of text and image blocks (`type` `text`, `image`, or `image_url`). An image block is the `<｜deepseek_image｜>` placeholder.

`tools` is an OpenAI tool list (`{ "type": "function", "function": { ... } }`). A list on the request is written into the leading system message, or into a new empty system message when the conversation does not start with one. A list already present on that system message is kept. The schemas are written into the prompt. Tool-call `arguments` may be an object or a JSON object string.

`tool_calls` on an assistant message is an OpenAI tool-call list. A `role: "tool"` message (`tool_call_id` plus `content`) is merged into a user turn as a `<tool_result>` block. Tool `content` must be a string, or a list of content blocks. Objects, numbers, booleans, and null are rejected: the official encoder prints those with Python's `repr`, and a JSON body cannot reproduce that exactly (`22.0` and `22` are the same number after parsing).

`reasoning_content` on an assistant message is that turn's thinking text.

Roles: `system`, `user`, `assistant`, `tool`, and `latest_reminder`. A system message is marked with `<｜System｜>`, including one in the middle of the conversation.

### Options

The prompt format comes from `config/deepseek-v4.1/encoding.py`. The prompt includes the BOS token and the assistant header.

`thinking` is `{ "type": "enabled" }` or `{ "type": "disabled" }`. Enabled opens the turn with `<think>`. Disabled closes it with `</think>`. `thinking_mode` (`thinking` or `chat`) and `enable_thinking` (`true` or `false`) are the same switch. When more than one is set they must agree. The default is thinking.

`drop_thinking` defaults to `true`. In thinking mode, `reasoning_content` on assistant turns before the last user message is left out of the prompt. If any message has `tools`, thinking is kept.

`reasoning_effort` is `low`, `high`, `max`, an integer from 1 to 100, or omitted. The default is `high`. In thinking mode the prompt starts with `Reasoning Effort: {budget}`. `low` is 50, `high` is 75, and `max` is 100. An integer is used as the budget.

### Limits

The free-plan defaults keep a worst-case request under the 10 ms CPU limit. The raw JSON body must be at most 48 KiB (`49152` bytes). The rendered prompt must be at most 8 KiB (`8192` bytes). Over either cap, the response is 413 `request_too_large`, and the tokenizer does not run. A body over the cap is rejected before `JSON.parse`. A prompt over the cap is rejected after the template is rendered and before tokenization.

A long run of digits is the slowest input measured in workerd. At 8 KiB a warm request takes about 9 ms in the handler. The cap stays there so that run stays under 10 ms. The body cap is the size of that prompt written with `\uXXXX` escapes, plus the JSON envelope and the chat-template overhead (170 bytes around an empty user message).

Both caps are [vars](https://developers.cloudflare.com/workers/wrangler/configuration/#vars). A positive integer replaces that default. An unset or invalid value leaves its default in place. The two settings are independent.

Wasm memory stays about 70 MiB through an 8 KiB prompt.

On the Workers Paid plan the default CPU limit is 30 seconds and `limits.cpu_ms` can raise it up to 5 minutes. Do not set `limits.cpu_ms` on the free plan; that configuration is rejected. A paid deploy can raise the caps and set the CPU limit:

```toml
[vars]
MAX_PROMPT_BYTES = "131072"
MAX_BODY_BYTES = "786432"

[limits]
cpu_ms = 200
```

`786432` is 768 KiB, enough for a `\uXXXX` encoding of a 128 KiB prompt. The isolate builds the vocabulary at startup and encodes a max-size digit run four times, so that one-time cost stays inside the 1 second startup limit.

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

Counts use the Hugging Face [`tokenizers`](https://github.com/huggingface/tokenizers) crate (0.23.2) compiled into the worker. The build turns default features off and enables `unstable_wasm`, so regular expressions use `fancy-regex` rather than the C `onig` library. `config/deepseek-v4.1/tokenizer.json` is embedded in the wasm module. Special tokens are not added during encode; the chat template writes them into the prompt.

The worker is the `crates/worker` crate, built with `worker-build`. The wasm module is built, not committed. `pnpm test`, `pnpm dev`, and `pnpm deploy` run that build.

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
cargo test -p encode
pnpm test
pnpm dev
```

Installs use `registry.npmjs.org` (`.npmrc`). The package manager is pnpm 12 (`packageManager` in `package.json`).

`cargo test -p encode` checks the chat template against `test/test_data/deepseek-v4.1`. `pnpm test` builds the wasm worker and replays `fixtures/golden.json` in workerd. Both need Rust 1.94.0 and the `wasm32-unknown-unknown` target (`rust-toolchain.toml`). `scripts/build-worker.sh` installs `worker-build` 0.8.7 and `wasm-bindgen` 0.2.129. CI installs that toolchain, then runs `cargo fmt`, `cargo clippy`, the crate tests, the wasm build, and the golden replay.
