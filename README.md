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
{ "data": { "total_tokens": 12 } }
```

`model` must be `deepseek-v4` or start with `deepseek-v4-`. Message `content` must be text. `thinking_mode` is `chat` (default) or `thinking`.

## Develop

```bash
bun install
bun run dev
bun run test
```
