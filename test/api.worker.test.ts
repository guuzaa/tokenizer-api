/// <reference types="@cloudflare/vitest-plugin/types" />
import { env } from "cloudflare:test";
import { expect, test } from "vitest";
import { MAX_BODY_BYTES } from "../src/limits";

const api = (env as unknown as { API: Fetcher }).API;

function post(body: unknown, ip: string): Promise<Response> {
  return api.fetch("http://example.com/v1/token/count", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": ip,
    },
    body: JSON.stringify(body),
  });
}

test("counts the README prompt inside workerd", async () => {
  const response = await post(
    {
      model: "deepseek-flash",
      thinking_mode: "chat",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello" },
      ],
    },
    "203.0.113.11",
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: { total_tokens: 12 } });
});

test("counts a few other prompts inside workerd", async () => {
  const empty = await post({ model: "deepseek-flash", messages: [{ role: "user", content: "" }] }, "203.0.113.12");
  expect(empty.status).toBe(200);
  expect(await empty.json()).toEqual({ data: { total_tokens: 30 } });

  const effort = await post(
    {
      model: "deepseek-flash",
      thinking_mode: "thinking",
      reasoning_effort: "max",
      messages: [{ role: "user", content: "Hello" }],
    },
    "203.0.113.13",
  );
  expect(effort.status).toBe(200);
  expect(await effort.json()).toEqual({ data: { total_tokens: 31 } });
});

test("rejects an unpaired surrogate inside workerd", async () => {
  const response = await post(
    { model: "deepseek-flash", messages: [{ role: "user", content: "\uD800" }] },
    "203.0.113.15",
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: { message: "text contains an unpaired surrogate", type: "invalid_request_error" },
  });
});

test("counts a deepseek-flash prompt inside workerd", async () => {
  const response = await post(
    {
      model: "deepseek-flash",
      thinking_mode: "chat",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello" },
      ],
    },
    "203.0.113.21",
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: { total_tokens: 12 } });
});

test("rejects an unknown model inside workerd", async () => {
  const response = await post({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }, "203.0.113.14");
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: { message: "unsupported model: gpt-4o", type: "invalid_request_error" },
  });
});

test("rejects an oversized body inside workerd before counting", async () => {
  const response = await post(
    { model: "deepseek-flash", messages: [{ role: "user", content: "x".repeat(MAX_BODY_BYTES) }] },
    "203.0.113.16",
  );
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({
    error: { message: `request body exceeds ${MAX_BODY_BYTES} bytes`, type: "request_too_large" },
  });
});

test("returns 429 after 60 requests from one IP", async () => {
  const ip = "203.0.113.60";
  const body = { model: "deepseek-flash", messages: [{ role: "user", content: "hi" }] };
  for (let i = 0; i < 60; i++) {
    const response = await post(body, ip);
    expect(response.status, `request ${i + 1}`).toBe(200);
  }
  const limited = await post(body, ip);
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBe("60");
  expect(await limited.json()).toEqual({ error: { message: "rate limit exceeded", type: "rate_limit_error" } });
});
