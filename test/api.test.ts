import { expect, test } from "vitest";
import { handleCount } from "../src/handle";
import { MAX_BODY_BYTES, MAX_PROMPT_BYTES } from "../src/limits";

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
      return 12;
    },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: { total_tokens: 12 } });
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

test("rejects other methods and paths", async () => {
  const missing = await handleCount(new Request("http://tokenizer.test/health"), () => 0);
  expect(missing.status).toBe(404);
  const get = await handleCount(new Request("http://tokenizer.test/v1/token/count"), () => 0);
  expect(get.status).toBe(405);
});
