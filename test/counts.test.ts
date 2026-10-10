import { expect, test } from "vitest";
import { encodeMessages, type ChatMessage, type EncodeOptions } from "../src/encoding/deepseek-v4";
import { countTokens } from "../src/tokenizer";

function count(messages: ChatMessage[], options: Partial<EncodeOptions> = {}): number {
  const prompt = encodeMessages(messages, { thinkingMode: "chat", ...options });
  return countTokens(prompt);
}

const readmeMessages: ChatMessage[] = [
  { role: "system", content: "You are a helpful assistant." },
  { role: "user", content: "Hello" },
];

test("README example counts 11 tokens", () => {
  expect(count(readmeMessages)).toBe(11);
});

test("chat template overhead and options match the tokenizer", () => {
  expect(count([{ role: "user", content: "" }])).toBe(4);
  expect(count([{ role: "user", content: "Hello" }])).toBe(5);
  expect(count([{ role: "user", content: "Hello" }], { addDefaultBosToken: false })).toBe(4);
  expect(count([{ role: "system", content: "You are a helpful assistant." }])).toBe(7);
  expect(count([{ role: "user", content: "👋" }])).toBe(6);
  expect(count(readmeMessages, { thinkingMode: "thinking" })).toBe(11);
  expect(count([{ role: "user", content: "Hello" }], { thinkingMode: "thinking", reasoningEffort: "high" })).toBe(5);
  expect(count([{ role: "user", content: "Hello" }], { thinkingMode: "thinking", reasoningEffort: "max" })).toBe(84);

  const withReasoning: ChatMessage[] = [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi", reasoning_content: "The user said hello." },
    { role: "user", content: "Again" },
  ];
  expect(count(withReasoning, { thinkingMode: "thinking" })).toBe(11);
  expect(count(withReasoning, { thinkingMode: "thinking", dropThinking: false })).toBe(17);
});
