import { expect, test } from "vitest";
import { deepseekFlash } from "../src/models/deepseek-flash";
import { countTokens } from "../src/models/counter";

function count(body: Record<string, unknown>): number {
  return countTokens(deepseekFlash.render(body));
}

const hello = { messages: [{ role: "user", content: "Hello" }] };
const withReasoning = {
  thinking_mode: "thinking" as const,
  messages: [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi", reasoning_content: "The user said hello." },
    { role: "user", content: "Again" },
  ],
};

test("V4.1 prompts count with the embedded tokenizer", () => {
  const encoder = new TextEncoder();
  expect({
    readmeChat: count({
      thinking_mode: "chat",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello" },
      ],
    }),
    readmeDefault: count({
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello" },
      ],
    }),
    chatHello: count({ ...hello, thinking_mode: "chat" }),
    defaultHello: count(hello),
    low: count({ ...hello, reasoning_effort: "low" }),
    max: count({ ...hello, reasoning_effort: "max" }),
    chatEmpty: count({ thinking_mode: "chat", messages: [{ role: "user", content: "" }] }),
    defaultEmpty: count({ messages: [{ role: "user", content: "" }] }),
    emoji: count({ thinking_mode: "chat", messages: [{ role: "user", content: "👋" }] }),
    dropped: count(withReasoning),
    kept: count({ ...withReasoning, drop_thinking: false }),
    emptyPromptBytes: encoder.encode(deepseekFlash.render({ messages: [{ role: "user", content: "" }] })).byteLength,
  }).toEqual({
    readmeChat: 12,
    readmeDefault: 37,
    chatHello: 5,
    defaultHello: 31,
    low: 31,
    max: 31,
    chatEmpty: 4,
    defaultEmpty: 30,
    emoji: 6,
    dropped: 37,
    kept: 43,
    emptyPromptBytes: 170,
  });
});
