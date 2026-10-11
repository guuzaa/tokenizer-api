import { countTokens } from "../src/models/deepseek-v4-tokenizer";

const loops = 30;

export default {
  async fetch(request: Request): Promise<Response> {
    const preset = new URL(request.url).searchParams.get("preset") ?? "small";
    const text = presetText(preset);
    let tokens = 0;
    const started = performance.now();
    for (let i = 0; i < loops; i++) tokens = countTokens(text);
    const encodeMs = (performance.now() - started) / loops;
    return Response.json({
      preset,
      bytes: new TextEncoder().encode(text).byteLength,
      tokens,
      loops,
      encodeMs,
    });
  },
};

function presetText(preset: string): string {
  if (preset === "small") return "Hello";
  const phrase = "你好，请用一句话介绍深度求索。";
  const phraseBytes = new TextEncoder().encode(phrase).byteLength;
  const target = preset === "mid" ? 1024 : 4096 - 64;
  return phrase.repeat(Math.ceil(target / phraseBytes)).slice(0, target);
}
