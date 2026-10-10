import { expect, test } from "vitest";
import { handleCount as dispatchCount, type CountEnv } from "../src/handle";

function handleCount(request: Request, countTokens: (text: string) => number, env: CountEnv = {}): Promise<Response> {
  return dispatchCount(request, env, { countTokens });
}
import { MAX_BODY_BYTES, MAX_PROMPT_BYTES, RATE_LIMIT_PERIOD_SECONDS } from "../src/limits";

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

test("rejects other methods and paths", async () => {
  const missing = await handleCount(new Request("http://tokenizer.test/health"), () => 0);
  expect(missing.status).toBe(404);
  const get = await handleCount(new Request("http://tokenizer.test/v1/token/count"), () => 0);
  expect(get.status).toBe(405);
});
