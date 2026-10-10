import { Tokenizer } from "@huggingface/tokenizers";
import { encodeMessages } from "../src/encoding/deepseek-v4";
import { MAX_PROMPT_BYTES } from "../src/limits";

const root = new URL("..", import.meta.url);
const jsonUrl = new URL("config/deepseek-v4/tokenizer.json", root);
const configUrl = new URL("config/deepseek-v4/tokenizer_config.json", root);

const readStarted = performance.now();
const tokenizerJson = await Bun.file(jsonUrl).json();
const tokenizerConfig = await Bun.file(configUrl).json();
const readMs = performance.now() - readStarted;

const constructStarted = performance.now();
const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
const constructMs = performance.now() - constructStarted;

function count(text: string): { tokens: number; ms: number } {
  const started = performance.now();
  const tokens = tokenizer.encode(text, { add_special_tokens: false }).ids.length;
  return { tokens, ms: performance.now() - started };
}

const phrase = "你好，请用一句话介绍深度求索。";
const sizes = [256, 1024, 2048, 4096, 8192, 16384, 32768];

console.log(`read json: ${readMs.toFixed(1)} ms`);
console.log(`construct Tokenizer: ${constructMs.toFixed(1)} ms`);
console.log(`heap: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB`);

for (const bytes of sizes) {
  const text = phrase.repeat(Math.ceil(bytes / Buffer.byteLength(phrase))).slice(0, bytes);
  const sample = count(text);
  console.log(
    `encode ~${Buffer.byteLength(text)} B -> ${sample.tokens} tokens in ${sample.ms.toFixed(2)} ms`,
  );
}

const chat = encodeMessages(
  [
    { role: "system", content: "你是助手" },
    { role: "user", content: "你好" },
  ],
  { thinkingMode: "chat" },
);
const tool = encodeMessages(
  [
    {
      role: "system",
      content: "You are helpful.",
      tools: [
        {
          type: "function",
          function: { name: "get_weather", description: "天气", parameters: { type: "object" } },
        },
      ],
    },
    { role: "user", content: "北京天气" },
  ],
  { thinkingMode: "chat" },
);
const underCap = "a".repeat(MAX_PROMPT_BYTES - 64);
for (const [name, prompt] of [
  ["chat", chat],
  ["tools", tool],
  ["under-cap", underCap],
] as const) {
  const sample = count(prompt);
  console.log(`${name}: ${Buffer.byteLength(prompt)} B -> ${sample.tokens} tokens in ${sample.ms.toFixed(2)} ms`);
}
