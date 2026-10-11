import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { encodeMessages, EncodeError } from "../src/encoding/deepseek-flash";
import { toJson } from "../src/encoding/shared";
import { deepseekFlash } from "../src/models/deepseek-flash";

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "test_data/deepseek-v4.1");

/** A message list has no mode of its own. Those fixtures are chat prompts. */
function requestBody(raw: unknown): Record<string, unknown> {
  if (Array.isArray(raw)) return { messages: raw, thinking_mode: "chat" };
  if (raw == null || typeof raw !== "object") throw new Error("fixture must be a request object or a message list");
  return raw as Record<string, unknown>;
}

function loadCases(): Array<{ id: string; body: Record<string, unknown>; expected: string }> {
  const inputs = readdirSync(dataDir)
    .filter((name) => /^test_input_\d+\.json$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  return inputs.map((name) => {
    const id = name.match(/\d+/)![0]!;
    return {
      id,
      body: requestBody(JSON.parse(readFileSync(join(dataDir, name), "utf8")) as unknown),
      expected: readFileSync(join(dataDir, `test_output_${id}.txt`), "utf8"),
    };
  });
}

describe("deepseek-flash fixtures", () => {
  test.each(loadCases())("test_input_$id matches test_output_$id", ({ body, expected }) => {
    expect(deepseekFlash.render(body)).toBe(expected);
  });
});

test("counts the chat hello prompt", async () => {
  const { countTokens } = await import("../src/models/counter");
  const prompt = deepseekFlash.render({
    thinking_mode: "chat",
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello" },
    ],
  });
  expect(countTokens(prompt)).toBe(12);
});

test("the request defaults to thinking with a high budget and can turn that off", () => {
  const thinking = deepseekFlash.render({ messages: [{ role: "user", content: "hi" }] });
  expect(thinking).toContain("Reasoning Effort: 75 ");
  expect(thinking.endsWith("<｜Assistant｜><think>")).toBe(true);

  const chat = deepseekFlash.render({
    messages: [{ role: "user", content: "hi" }],
    enable_thinking: false,
  });
  expect(chat.includes("Reasoning Effort:")).toBe(false);
  expect(chat.endsWith("<｜Assistant｜></think>")).toBe(true);

  expect(() =>
    deepseekFlash.render({ messages: [{ role: "user", content: "hi" }], reasoning_effort: "medium" }),
  ).toThrow(/Invalid reasoning effort/);
});

test("request tools are attached, and string tool arguments are expanded", () => {
  const prompt = deepseekFlash.render({
    messages: [{ role: "user", content: "算一下" }],
    tools: [{ type: "function", function: { name: "Calculator", description: "算术", parameters: { type: "object" } } }],
    thinking_mode: "chat",
  });
  expect(prompt.startsWith("<｜begin▁of▁sentence｜><｜System｜>\n\n## Tools\n")).toBe(true);
  expect(prompt).toContain('"name": "Calculator"');
  expect(prompt).toContain("<｜User｜>算一下<｜Assistant｜></think>");
});

test("rejects an unknown role, a bad effort, and an image placeholder in text", () => {
  expect(() =>
    encodeMessages([{ role: "critic", content: "no" }], {
      thinkingMode: "chat",
      dropThinking: true,
      reasoningEffort: null,
    }),
  ).toThrow(/Unknown role: critic/);

  expect(() => deepseekFlash.render({ messages: [{ role: "user", content: "hi" }], reasoning_effort: "xhigh" })).toThrow(
    EncodeError,
  );
  expect(() =>
    deepseekFlash.render({
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled" },
      enable_thinking: false,
    }),
  ).toThrow(/must select the same mode/);
  expect(() =>
    deepseekFlash.render({
      messages: [{ role: "user", content: [{ type: "text", text: "see <｜deepseek_image｜>" }] }],
    }),
  ).toThrow(/image placeholder/);
});

test("toJson matches json.dumps", () => {
  const sample = { a: 1, b: "中文", nested: { ok: true, n: null } };
  const py = spawnSync(
    "python3",
    ["-c", "import json,sys; print(json.dumps(json.load(sys.stdin), ensure_ascii=False))"],
    { input: JSON.stringify(sample), encoding: "utf8" },
  );
  expect(py.status, py.stderr || "json.dumps failed").toBe(0);
  expect(toJson(sample)).toBe(py.stdout.trimEnd());
});

test("rejects tool content that is not a string and renders string tool content", () => {
  const options = { thinkingMode: "chat" as const, dropThinking: true, reasoningEffort: null };
  expect(() => encodeMessages([{ role: "tool", tool_call_id: "call_1", content: { temperature: 22 } }], options)).toThrow(
    /tool content must be a string/,
  );
  expect(() => encodeMessages([{ role: "tool", tool_call_id: "call_1", content: 22 }], options)).toThrow(
    /tool content must be a string/,
  );
  const empty = encodeMessages([{ role: "tool", tool_call_id: "call_1", content: null }], options);
  expect(empty).toContain("<tool_result></tool_result>");
  const prompt = encodeMessages([{ role: "tool", tool_call_id: "call_1", content: '{"temperature": 22}' }], options);
  expect(prompt).toContain('<tool_result>{"temperature": 22}</tool_result>');
});
