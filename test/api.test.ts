import { expect, test } from "vitest";
import { encodeMessages } from "../src/encoding/deepseek-v4";
import { handleCount as dispatchCount, type CountEnv } from "../src/handle";
import { MAX_BODY_BYTES, MAX_PROMPT_BYTES, RATE_LIMIT_PERIOD_SECONDS } from "../src/limits";
import { models } from "../src/models/runtime";

function handleCount(request: Request, countTokens: (text: string) => number, env: CountEnv = {}): Promise<Response> {
  return dispatchCount(request, env, { countTokens });
}

const textEncoder = new TextEncoder();

function userPromptBytes(content: string): number {
  return textEncoder.encode(
    encodeMessages([{ role: "user", content }], { thinkingMode: "chat", dropThinking: true, addDefaultBosToken: true }),
  ).byteLength;
}

function post(body: unknown, headers?: HeadersInit): Request {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return new Request("http://tokenizer.test/v1/token/count", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: payload,
  });
}

test("returns the counter result for a deepseek-v4 chat", async () => {
  let seen = "";
  const response = await handleCount(
    post({
      model: "deepseek-v4-flash",
      messages: [
        { role: "system", content: "你是助手" },
        { role: "user", content: "你好" },
      ],
    }),
    (prompt) => {
      seen = prompt;
      return 7;
    },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: { total_tokens: 7 } });
  expect(seen).toContain("<｜begin▁of▁sentence｜>");
  expect(seen).toContain("<｜User｜>你好");
  expect(seen.endsWith("<｜Assistant｜></think>")).toBe(true);
});

test("thinking.type enabled opens the think token", async () => {
  let seen = "";
  const response = await handleCount(
    post({
      model: "deepseek-v4-flash",
      thinking: { type: "enabled" },
      reasoning_effort: "medium",
      messages: [{ role: "user", content: "你好" }],
    }),
    (prompt) => {
      seen = prompt;
      return 1;
    },
  );
  expect(response.status).toBe(200);
  expect(seen.endsWith("<｜Assistant｜><think>")).toBe(true);
  expect(seen.includes("Absolute maximum")).toBe(false);
});

test("maps low and medium onto high, and xhigh onto the max prefix", async () => {
  const render = async (reasoning_effort: string): Promise<string> => {
    let seen = "";
    const response = await handleCount(
      post({
        model: "deepseek-v4-flash",
        thinking: { type: "enabled" },
        reasoning_effort,
        messages: [{ role: "user", content: "你好" }],
      }),
      (prompt) => {
        seen = prompt;
        return 1;
      },
    );
    expect(response.status).toBe(200);
    return seen;
  };

  const high = await render("high");
  expect(await render("medium")).toBe(high);
  expect(await render("low")).toBe(high);
  expect(high.endsWith("<｜Assistant｜><think>")).toBe(true);

  const max = await render("max");
  expect(await render("xhigh")).toBe(max);
  expect(max.startsWith("<｜begin▁of▁sentence｜>Reasoning Effort: Absolute maximum")).toBe(true);
  expect(max.endsWith("<｜Assistant｜><think>")).toBe(true);
});

test("writes request-level tools into the system message", async () => {
  let seen = "";
  const response = await handleCount(
    post({
      model: "deepseek-v4-flash",
      thinking: { type: "enabled" },
      messages: [
        { role: "system", content: "你是助手" },
        { role: "user", content: "算一下" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "Calculator",
            description: "算术",
            parameters: { type: "object", properties: { formula: { type: "string" } } },
          },
        },
      ],
    }),
    (prompt) => {
      seen = prompt;
      return 1;
    },
  );
  expect(response.status).toBe(200);
  expect(seen).toContain("你是助手\n\n## Tools\n");
  expect(seen).toContain('"name": "Calculator"');
  expect(seen.endsWith("<｜Assistant｜><think>")).toBe(true);
});

test("prepends request-level tools when the conversation has no system message", async () => {
  let seen = "";
  const response = await handleCount(
    post({
      model: "deepseek-v4",
      messages: [{ role: "user", content: "算一下" }],
      tools: [{ type: "function", function: { name: "Calculator", parameters: { type: "object" } } }],
    }),
    (prompt) => {
      seen = prompt;
      return 1;
    },
  );
  expect(response.status).toBe(200);
  expect(seen.startsWith("<｜begin▁of▁sentence｜>\n\n## Tools\n")).toBe(true);
  expect(seen).toContain("<｜User｜>算一下");
});

test("rejects an unknown reasoning effort and a conflicting thinking switch", async () => {
  const effort = await handleCount(
    post({
      model: "deepseek-v4-flash",
      thinking: { type: "enabled" },
      reasoning_effort: "minimal",
      messages: [{ role: "user", content: "你好" }],
    }),
    () => {
      throw new Error("should not count");
    },
  );
  expect(effort.status).toBe(400);
  expect(await effort.json()).toEqual({
    error: {
      message: 'reasoning_effort must be "low", "medium", "high", "max", "xhigh", or null',
      type: "invalid_request_error",
    },
  });

  const conflict = await handleCount(
    post({
      model: "deepseek-v4-flash",
      thinking: { type: "enabled" },
      thinking_mode: "chat",
      messages: [{ role: "user", content: "你好" }],
    }),
    () => {
      throw new Error("should not count");
    },
  );
  expect(conflict.status).toBe(400);
});

test("rejects an unpaired surrogate before counting", async () => {
  const response = await dispatchCount(
    post({ model: "deepseek-v4", messages: [{ role: "user", content: "\uD800" }] }),
    {},
    { models },
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: { message: "text contains an unpaired surrogate", type: "invalid_request_error" },
  });
});

test("rejects an unknown model", async () => {
  const response = await handleCount(
    post({ model: "step-5-preview", messages: [{ role: "user", content: "hi" }] }),
    () => {
      throw new Error("should not count");
    },
  );
  expect(response.status).toBe(400);
});

test("rejects non-string tool content", async () => {
  const response = await handleCount(
    post({
      model: "deepseek-v4",
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{\"location\":\"Beijing\"}" } }],
        },
        { role: "tool", tool_call_id: "call_1", content: { temperature: 22 } },
      ],
    }),
    () => {
      throw new Error("should not count");
    },
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: { message: "message 1 content must be a string", type: "invalid_request_error" },
  });
});

test("rejects image content", async () => {
  const response = await handleCount(
    post({
      model: "deepseek-v4",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }],
    }),
    () => {
      throw new Error("should not count");
    },
  );
  expect(response.status).toBe(400);
});

test("rejects a body over the byte cap before counting", async () => {
  const payload = JSON.stringify({
    model: "deepseek-v4",
    messages: [{ role: "user", content: "x".repeat(MAX_BODY_BYTES) }],
  });
  const response = await handleCount(
    new Request("http://tokenizer.test/v1/token/count", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(payload.length) },
      body: payload,
    }),
    () => {
      throw new Error("should not count");
    },
  );
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({
    error: { message: `request body exceeds ${MAX_BODY_BYTES} bytes`, type: "request_too_large" },
  });
});

test("rejects a non-JSON body over the cap before parsing", async () => {
  const payload = `not-json${"x".repeat(MAX_BODY_BYTES)}`;
  const response = await handleCount(
    new Request("http://tokenizer.test/v1/token/count", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(textEncoder.encode(payload).byteLength) },
      body: payload,
    }),
    () => {
      throw new Error("should not count");
    },
  );
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({
    error: { message: `request body exceeds ${MAX_BODY_BYTES} bytes`, type: "request_too_large" },
  });
});

test("accepts a body at the cap and rejects one byte more", async () => {
  const core = JSON.stringify({ model: "deepseek-v4", messages: [{ role: "user", content: "hi" }] });
  const coreBytes = textEncoder.encode(core).byteLength;
  const atCap = core + " ".repeat(MAX_BODY_BYTES - coreBytes);
  expect(textEncoder.encode(atCap).byteLength).toBe(MAX_BODY_BYTES);
  const allowed = await handleCount(
    new Request("http://tokenizer.test/v1/token/count", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(MAX_BODY_BYTES) },
      body: atCap,
    }),
    () => 2,
  );
  expect(allowed.status).toBe(200);

  const over = `${atCap} `;
  const denied = await handleCount(
    new Request("http://tokenizer.test/v1/token/count", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(textEncoder.encode(over).byteLength) },
      body: over,
    }),
    () => {
      throw new Error("should not count");
    },
  );
  expect(denied.status).toBe(413);
});

test("rejects a rendered prompt over the cap before counting", async () => {
  const response = await handleCount(
    post({
      model: "deepseek-v4",
      messages: [{ role: "user", content: "a".repeat(MAX_PROMPT_BYTES) }],
    }),
    () => {
      throw new Error("should not count");
    },
  );
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({
    error: { message: `rendered prompt exceeds ${MAX_PROMPT_BYTES} bytes`, type: "request_too_large" },
  });
});

test("accepts a rendered prompt at the default cap", async () => {
  const content = "7".repeat(MAX_PROMPT_BYTES - userPromptBytes(""));
  expect(userPromptBytes(content)).toBe(MAX_PROMPT_BYTES);
  const atCap = await handleCount(post({ model: "deepseek-v4", messages: [{ role: "user", content }] }), () => 2);
  expect(atCap.status).toBe(200);

  const oneOver = await handleCount(
    post({ model: "deepseek-v4", messages: [{ role: "user", content: `${content}7` }] }),
    () => {
      throw new Error("should not count");
    },
  );
  expect(oneOver.status).toBe(413);
  expect(await oneOver.json()).toEqual({
    error: { message: `rendered prompt exceeds ${MAX_PROMPT_BYTES} bytes`, type: "request_too_large" },
  });
});

test("a positive integer var overrides that cap and an invalid var does not", async () => {
  const overDefault = "c".repeat(MAX_PROMPT_BYTES);
  const raised = await handleCount(
    post({ model: "deepseek-v4", messages: [{ role: "user", content: overDefault }] }),
    () => 2,
    { MAX_PROMPT_BYTES: "16384" },
  );
  expect(raised.status).toBe(200);

  const ignored = await handleCount(
    post({ model: "deepseek-v4", messages: [{ role: "user", content: overDefault }] }),
    () => {
      throw new Error("should not count");
    },
    { MAX_PROMPT_BYTES: "nope" },
  );
  expect(ignored.status).toBe(413);
  expect(await ignored.json()).toEqual({
    error: { message: `rendered prompt exceeds ${MAX_PROMPT_BYTES} bytes`, type: "request_too_large" },
  });

  const tiny = await handleCount(post({ model: "deepseek-v4", messages: [{ role: "user", content: "hi" }] }), () => {
    throw new Error("should not count");
  }, { MAX_BODY_BYTES: 32 });
  expect(tiny.status).toBe(413);
  expect(await tiny.json()).toEqual({
    error: { message: "request body exceeds 32 bytes", type: "request_too_large" },
  });
});

function limiter(allow: number): { env: CountEnv; keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    env: {
      RATE_LIMITER: {
        async limit({ key }) {
          keys.push(key);
          return { success: keys.filter((seen) => seen === key).length <= allow };
        },
      },
    },
  };
}

const hello = { model: "deepseek-v4", messages: [{ role: "user", content: "hi" }] };

test("limits each client IP and returns retry-after", async () => {
  const { env, keys } = limiter(1);
  const first = await handleCount(post(hello, { "CF-Connecting-IP": "203.0.113.5" }), () => 3, env);
  const second = await handleCount(post(hello, { "CF-Connecting-IP": "203.0.113.5" }), () => {
    throw new Error("should not count");
  }, env);
  const other = await handleCount(post(hello, { "CF-Connecting-IP": "203.0.113.6" }), () => 3, env);
  expect(first.status).toBe(200);
  expect(second.status).toBe(429);
  expect(second.headers.get("retry-after")).toBe(String(RATE_LIMIT_PERIOD_SECONDS));
  expect(await second.json()).toEqual({ error: { message: "rate limit exceeded", type: "rate_limit_error" } });
  expect(other.status).toBe(200);
  expect(keys.every((key) => key.startsWith("ip:"))).toBe(true);
});

test("stays public when API_KEYS is unset and requires a bearer token when it is set", async () => {
  const open = await handleCount(post(hello), () => 3, {});
  expect(open.status).toBe(200);

  const { env } = limiter(10);
  env.API_KEYS = "one, two";
  const missing = await handleCount(post(hello, { "CF-Connecting-IP": "198.51.100.1" }), () => {
    throw new Error("should not count");
  }, env);
  const bad = await handleCount(post(hello, { authorization: "Bearer nope", "CF-Connecting-IP": "198.51.100.1" }), () => {
    throw new Error("should not count");
  }, env);
  const good = await handleCount(post(hello, { authorization: "Bearer two", "CF-Connecting-IP": "198.51.100.1" }), () => 3, env);
  expect(missing.status).toBe(401);
  expect(bad.status).toBe(401);
  expect(await bad.json()).toEqual({ error: { message: "invalid api key", type: "authentication_error" } });
  expect(good.status).toBe(200);
  expect(env.RATE_LIMITER && (await good.json())).toEqual({ data: { total_tokens: 3 } });
});

test("rate limits a valid API key separately from its IP", async () => {
  const { env, keys } = limiter(1);
  env.API_KEYS = "secret-token";
  const headers = { authorization: "Bearer secret-token", "CF-Connecting-IP": "198.51.100.8" };
  const first = await handleCount(post(hello, headers), () => 3, env);
  const second = await handleCount(post(hello, headers), () => {
    throw new Error("should not count");
  }, env);
  expect(first.status).toBe(200);
  expect(second.status).toBe(429);
  expect(keys[0]?.startsWith("key:")).toBe(true);
  expect(keys[0]).not.toContain("secret-token");
});

test("counts a deepseek-flash chat with the V4.1 template", async () => {
  let seen = "";
  const response = await handleCount(
    post({
      model: "deepseek-flash",
      messages: [
        { role: "system", content: "你是助手" },
        { role: "user", content: "你好" },
      ],
    }),
    (prompt) => {
      seen = prompt;
      return 9;
    },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: { total_tokens: 9 } });
  expect(seen).toContain("Reasoning Effort: 75 ");
  expect(seen).toContain("<｜System｜>");
  expect(seen.endsWith("<｜Assistant｜><think>")).toBe(true);
});

test("rejects other methods and paths", async () => {
  const missing = await handleCount(new Request("http://tokenizer.test/health"), () => 0);
  expect(missing.status).toBe(404);
  const get = await handleCount(new Request("http://tokenizer.test/v1/token/count"), () => 0);
  expect(get.status).toBe(405);
});
