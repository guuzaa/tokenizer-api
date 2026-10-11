# tokenizer-api

Count the prompt tokens for a [DeepSeek chat completion](https://api-docs.deepseek.com/api/create-chat-completion) request.

## Quick start

`POST /v1/token/count`

```bash
curl http://localhost:8787/v1/token/count \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-flash","messages":[{"role":"user","content":"Hello"}]}'
```

```json
{"data":{"total_tokens":31}}
```

`pnpm dev` serves that URL. Thinking is on unless you turn it off, and the prompt then includes a reasoning-effort line. The same message with `"thinking":{"type":"disabled"}` returns `{"data":{"total_tokens":5}}`.

## Request

The body is a JSON object. Names and types below match the [chat completions](https://api-docs.deepseek.com/api/create-chat-completion) request where this endpoint uses that field. Link there for the full chat schema. This service only counts the prompt.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `model` | string | yes | | `deepseek-flash`, or any name that starts with `deepseek-v4.1-` (`deepseek-v4.1-flash` is one). |
| `messages` | object[] | yes | | At least one message. See below. |
| `thinking` | object | no | `{"type":"enabled"}` | `type` is `enabled` or `disabled`. |
| `reasoning_effort` | string or integer | no | `high` | `low` (budget 50), `high` (75), `max` (100), or an integer from 1 to 100. The line is written only in thinking mode. |
| `tools` | object[] | no | | Function tools. Copied onto the first system message, or onto a new empty system message. An empty list is ignored. |
| `thinking_mode` | string | no | `thinking` | Extra field. `thinking` or `chat`. Same switch as `thinking`. |
| `enable_thinking` | boolean | no | `true` | Extra field. Same switch as `thinking`. |
| `drop_thinking` | boolean | no | `true` | Extra field. In thinking mode, omit `reasoning_content` from assistant turns before the last user message. |

`thinking`, `thinking_mode`, and `enable_thinking` must agree when more than one is set. `disabled`, `chat`, and `false` are the non-thinking mode.

Rejected `reasoning_effort` values: `none`, `minimal`, `medium`, and `xhigh`. Turn thinking off with `thinking.type` set to `disabled`.

A request `tools` list is skipped when the first message is already a system message with its own `tools`. If any message has `tools`, `reasoning_content` is kept even when `drop_thinking` is true.

### Messages

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `role` | string | yes | | `system`, `user`, `assistant`, or `tool`. `latest_reminder` is also accepted. |
| `content` | string or object[] | yes for system and user | | User and tool content may be a string or an array of content parts. |
| `reasoning_content` | string | no | | Assistant thinking text. Counted in thinking mode when it is not dropped. |
| `tool_calls` | object[] | no | | Assistant function calls. `function.arguments` may be an object or a JSON object string. |
| `tool_call_id` | string | yes on `tool` | | Tool call this message answers. The tool turn is merged into a user turn. |
| `tools` | object[] | no | | On a system message, the schemas are written into that turn. |
| `response_format` | object | no | | On a system message, the schema is written into that turn. |
| `name` | string | no | | Ignored. |
| `prefix` | boolean | no | | Ignored. |

Content parts follow the chat API: `text` (`text`) and `image_url` (`image_url.url`, a string or `{ "url": "..." }`). An image part counts as one placeholder token. Image bytes are unused, and `detail` is ignored. A part with `type: "image"` and `source`, `url`, or `data` is the same placeholder. A `file` part becomes the text `[Unsupported file]`.

Tool `content` must be a string or an array of content parts. A number, boolean, or object is rejected. A `tool` message is merged into the following user turn as a tool result.

A message may also set `task` (`action`, `query`, `authority`, `domain`, `title`, or `read_url`) and `wo_eos` (boolean). Those are not chat-completion fields.

### Ignored chat-completion fields

These fields are accepted and left unused: `max_tokens`, `stop`, `stream`, `stream_options`, `temperature`, `top_p`, `tool_choice`, `logprobs`, `top_logprobs`, `frequency_penalty`, `presence_penalty`, `user_id`, and a top-level `response_format`. `stream: true` still returns one JSON object.

## Response

`200` with `Content-Type: application/json; charset=utf-8`.

```json
{"data":{"total_tokens":31}}
```

`total_tokens` is the rendered prompt. In a chat completion, `usage.total_tokens` also includes the generated completion.

## Errors

```json
{"error":{"message":"messages must be a non-empty array","type":"invalid_request_error"}}
```

| Status | `type` | When |
| --- | --- | --- |
| 400 | `invalid_request_error` | The body is not a JSON object, `model` is missing, the model name is unsupported, the encoder rejects the body, or the prompt contains an unpaired UTF-16 surrogate. |
| 401 | `authentication_error` | `API_KEYS` is set and the bearer token is missing or unknown. Message: `invalid api key`. |
| 404 | `not_found` | The path is not `/v1/token/count`. |
| 405 | `method_not_allowed` | The path is `/v1/token/count` and the method is not `POST`. |
| 413 | `request_too_large` | The raw body or the rendered prompt is over its cap. The tokenizer is skipped. |
| 429 | `rate_limit_error` | The caller is over 60 requests in 60 seconds. Header: `Retry-After: 60`. |
| 500 | `internal_error` | Rendering or counting failed unexpectedly. |

A body over the cap is rejected before it is parsed. The 413 message is `request body exceeds 49152 bytes` or `rendered prompt exceeds 8192 bytes`, using the configured caps.

## Limits and rate limiting

The raw JSON body may be at most 48 KiB (`49152` bytes). The rendered prompt may be at most 8 KiB (`8192` bytes).

Each caller may send 60 requests per 60 seconds. The [Workers rate limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) counts per Cloudflare location. Public requests are keyed on `CF-Connecting-IP`. Requests with no such header share an `unknown` bucket. A valid API key is keyed on a hash of that key. The limit is applied before the 401 check, so an unknown bearer token still counts against the IP bucket.

## Configuration

`wrangler.toml` sets the caps and the rate limit. A positive integer in either var replaces that default. Anything else leaves the default. The two caps are independent.

```toml
[vars]
MAX_PROMPT_BYTES = "8192"
MAX_BODY_BYTES = "49152"
```

On the free plan, leave `[limits] cpu_ms` unset. A paid deploy can raise the two vars and set `cpu_ms`.

The endpoint is public until the `API_KEYS` secret is set. The value is a comma-separated list of bearer tokens. Do not commit it.

```bash
wrangler secret put API_KEYS
```

Send `Authorization: Bearer <token>`. With no secret, a bearer token is ignored and the endpoint stays public. The limit and the binding name are in `wrangler.toml`. The deploy route there is `api.paulden.site`.

## Development

```bash
pnpm install
pnpm dev
pnpm test
pnpm check
pnpm bench
pnpm deploy
```

Installs use `registry.npmjs.org`. The package manager is pnpm 12 (`packageManager` in `package.json`).

`pnpm dev`, `pnpm test`, `pnpm check`, and `pnpm deploy` build the wasm module first (`pnpm build:wasm`). That build needs Rust, the `wasm32-unknown-unknown` target, and wasm-bindgen 0.2.129. `scripts/build-wasm.sh` installs that wasm-bindgen release when it is missing, and embeds `config/deepseek-v4.1/tokenizer.json`. `pnpm test` runs the node tests and the workerd tests. `pnpm bench` times the counter under workerd. `pnpm types` refreshes the Wrangler types.
