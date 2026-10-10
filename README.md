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

`tool_calls` on an assistant message is an OpenAI tool-call list. A `role: "tool"` message (`tool_call_id` plus string `content`) is merged into a user turn as a `<tool_result>` block. Non-string tool `content` is rejected.

`reasoning_content` on an assistant message is that turn's thinking text.

Other roles: `system`, `developer`, `user`, `assistant`, and `latest_reminder`.

### Options

`thinking_mode` is `chat` (default) or `thinking`. Chat closes the turn with `</think>`. Thinking closes it with `<think>`.

`drop_thinking` defaults to `true`. In thinking mode, `reasoning_content` on assistant turns before the last user message is left out of the prompt. If any message has `tools`, thinking is kept.

`add_default_bos_token` defaults to `true`. It prepends the BOS token at the start of the conversation.

`reasoning_effort` is `max`, `high`, or `null` (default). In thinking mode, `max` prepends the "Absolute maximum..." instruction. `high` is accepted and adds nothing. That matches current DeepSeek V4 Pro and Flash. It does not match the older Flash-0731 template, where `high` and `max` are different prefixes.

### Limits

The raw JSON body must be at most 16 KiB. The rendered prompt must be at most 4 KiB. Over either cap, the response is 413.

### Errors

```json
{ "error": { "message": "messages must be a non-empty array", "type": "invalid_request_error" } }
```

| Status | `type` |
| --- | --- |
| 400 | `invalid_request_error` |
| 404 | `not_found` |
| 405 | `method_not_allowed` |
| 413 | `request_too_large` |
| 500 | `internal_error` |

## Develop

```bash
bun install
bun run dev
bun run test
```
