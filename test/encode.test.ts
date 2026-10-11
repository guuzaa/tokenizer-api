import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { encodeMessages, EncodeError, toJson, type ChatMessage, type ThinkingMode } from "../src/encoding/deepseek-v4";

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "test_data/deepseek-v4");

/** Cases 1–3 keep reasoning; case 4 is a chat prompt with an action task. */
const thinkingModeByCase: Record<string, ThinkingMode> = {
  "1": "thinking",
  "2": "thinking",
  "3": "thinking",
  "4": "chat",
};

function messagesFromInput(raw: unknown): ChatMessage[] {
  if (Array.isArray(raw)) return raw as ChatMessage[];
  if (raw == null || typeof raw !== "object") {
    throw new Error("input must be a message list or an object with messages");
  }
  const body = raw as { messages?: unknown; tools?: unknown };
  if (!Array.isArray(body.messages)) throw new Error("input object is missing messages");
  const messages = structuredClone(body.messages) as ChatMessage[];
  if (body.tools != null) {
    const target = messages.find((message) => message.role === "system") ?? messages[0];
    if (target && target.tools == null) target.tools = body.tools;
  }
  return messages;
}

function loadCases(): Array<{ id: string; messages: ChatMessage[]; expected: string; thinkingMode: ThinkingMode }> {
  const inputs = readdirSync(dataDir)
    .filter((name) => /^test_input_\d+\.json$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  return inputs.map((name) => {
    const id = name.match(/\d+/)![0];
    const thinkingMode = thinkingModeByCase[id];
    if (!thinkingMode) throw new Error(`missing thinking mode for test_input_${id}.json`);
    return {
      id,
      thinkingMode,
      messages: messagesFromInput(JSON.parse(readFileSync(join(dataDir, name), "utf8")) as unknown),
      expected: readFileSync(join(dataDir, `test_output_${id}.txt`), "utf8"),
    };
  });
}

const cases = loadCases();

describe("encodeMessages", () => {
  test.each(cases)("matches test_output_$id", ({ messages, expected, thinkingMode }) => {
    expect(encodeMessages(messages, { thinkingMode })).toBe(expected);
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

  test("rejects an unknown role", () => {
    expect(() => encodeMessages([{ role: "critic", content: "no" }], { thinkingMode: "chat" })).toThrow(EncodeError);
  });

  test("rejects tool content that is not a string", () => {
    expect(() =>
      encodeMessages([{ role: "tool", tool_call_id: "call_1", content: { temperature: 22 } }], { thinkingMode: "chat" }),
    ).toThrow(/tool content must be a string/);
    expect(() =>
      encodeMessages([{ role: "tool", tool_call_id: "call_1", content: 22 }], { thinkingMode: "chat" }),
    ).toThrow(/tool content must be a string/);
    expect(() =>
      encodeMessages([{ role: "tool", tool_call_id: "call_1", content: null }], { thinkingMode: "chat" }),
    ).toThrow(/tool content must be a string/);
  });

  test("renders string tool content as a tool result", () => {
    const prompt = encodeMessages(
      [{ role: "tool", tool_call_id: "call_1", content: "{\"temperature\": 22}" }],
      { thinkingMode: "chat" },
    );
    expect(prompt).toContain("<tool_result>{\"temperature\": 22}</tool_result>");
  });
});
