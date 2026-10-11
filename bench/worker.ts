import { encodeMessages, type ChatMessage } from "../src/encoding/deepseek-flash";
import { countTokens } from "../src/models/counter";

const loops = 30;
/** encodeMessages finishes well under 1ms, and workerd's clock is about 1ms. */
const encodeLoops = 1000;
const textEncoder = new TextEncoder();

const toolMessages: ChatMessage[] = [
  {
    role: "system",
    content: "You are a helpful assistant.",
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "查询天气",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      },
    ],
  },
  { role: "user", content: "北京天气怎么样？" },
  {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: "c1",
        type: "function",
        function: { name: "get_weather", arguments: JSON.stringify({ city: "北京" }) },
      },
    ],
  },
  { role: "tool", tool_call_id: "c1", content: "晴，26度" },
  { role: "user", content: "谢谢" },
];

export default {
  async fetch(request: Request): Promise<Response> {
    const preset = new URL(request.url).searchParams.get("preset") ?? "small";
    if (preset.startsWith("encode:")) return encodeResponse(preset.slice("encode:".length));

    const text = presetText(preset);
    let tokens = 0;
    const started = performance.now();
    for (let i = 0; i < loops; i++) tokens = countTokens(text);
    const encodeMs = (performance.now() - started) / loops;
    return Response.json({
      preset,
      bytes: textEncoder.encode(text).byteLength,
      tokens,
      loops,
      encodeMs,
    });
  },
};

function encodeResponse(preset: string): Response {
  const messages = preset === "tools" ? toolMessages : [{ role: "user", content: presetText(preset) }];
  const encoded = timeEncode(encodeLoops, () =>
    encodeMessages(messages, { thinkingMode: "chat", dropThinking: true, reasoningEffort: null }),
  );
  return Response.json({
    preset: `encode:${preset}`,
    thinkingMode: "chat",
    inputBytes: textEncoder.encode(JSON.stringify(messages)).byteLength,
    loops: encodeLoops,
    encodeMs: encoded.encodeMs,
    outputBytes: encoded.outputBytes,
    tokens: countTokens(encoded.prompt),
  });
}

function timeEncode(times: number, render: () => string): { encodeMs: number; outputBytes: number; prompt: string } {
  let prompt = "";
  const started = performance.now();
  for (let i = 0; i < times; i++) prompt = render();
  return {
    encodeMs: (performance.now() - started) / times,
    outputBytes: textEncoder.encode(prompt).byteLength,
    prompt,
  };
}

function presetText(preset: string): string {
  if (preset === "small") return "Hello";
  const phrase = "你好，请用一句话介绍深度求索。";
  const phraseBytes = textEncoder.encode(phrase).byteLength;
  const target = preset === "mid" ? 1024 : 4096 - 64;
  return phrase.repeat(Math.ceil(target / phraseBytes)).slice(0, target);
}
