export class EncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncodeError";
  }
}

export const bosToken = "<｜begin▁of▁sentence｜>";
export const eosToken = "<｜end▁of▁sentence｜>";
export const thinkingStartToken = "<think>";
export const thinkingEndToken = "</think>";
export const dsmlToken = "｜DSML｜";

export const userSpToken = "<｜User｜>";
export const assistantSpToken = "<｜Assistant｜>";
export const latestReminderSpToken = "<｜latest_reminder｜>";

export const taskTokens = {
  action: "<｜action｜>",
  query: "<｜query｜>",
  authority: "<｜authority｜>",
  domain: "<｜domain｜>",
  title: "<｜title｜>",
  read_url: "<｜read_url｜>",
} as const;

export const validTasks = new Set<string>(Object.keys(taskTokens));

export const responseFormatTemplate =
  "## Response Format:\n\nYou MUST strictly adhere to the following schema to reply:\n";

export type ThinkingMode = "chat" | "thinking";

export interface ContentBlock {
  type?: string;
  text?: unknown;
  content?: unknown;
  tool_use_id?: string;
}

export interface ChatMessage {
  role?: string;
  content?: unknown;
  content_blocks?: ContentBlock[];
  tools?: unknown;
  response_format?: unknown;
  tool_calls?: unknown;
  reasoning_content?: unknown;
  wo_eos?: boolean;
  task?: string | null;
  tool_call_id?: string;
  mask?: unknown;
}

export function pyTruthy(value: unknown): boolean {
  if (value == null || value === false || value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export function pyOrEmpty(value: unknown): string {
  if (!pyTruthy(value)) return "";
  return typeof value === "string" ? value : String(value);
}

function dumpString(value: string, ascii: boolean): string {
  let out = '"';
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (cp < 0x20) out += `\\u${cp.toString(16).padStart(4, "0")}`;
    else if (ascii && cp > 0x7f) {
      if (cp > 0xffff) {
        const v = cp - 0x10000;
        const hi = 0xd800 + (v >> 10);
        const lo = 0xdc00 + (v & 0x3ff);
        out += `\\u${hi.toString(16).padStart(4, "0")}\\u${lo.toString(16).padStart(4, "0")}`;
      } else {
        out += `\\u${cp.toString(16).padStart(4, "0")}`;
      }
    } else {
      out += ch;
    }
  }
  return `${out}"`;
}

function dumps(value: unknown, ascii: boolean): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      if (Number.isNaN(value)) return "NaN";
      return value > 0 ? "Infinity" : "-Infinity";
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") return dumpString(value, ascii);
  if (Array.isArray(value)) {
    return `[${value.map((item) => dumps(item, ascii)).join(", ")}]`;
  }
  if (typeof value === "object") {
    const parts: string[] = [];
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) continue;
      parts.push(`${dumpString(key, ascii)}: ${dumps(item, ascii)}`);
    }
    return `{${parts.join(", ")}}`;
  }
  throw new EncodeError("value is not JSON serializable");
}

/** Match Python `json.dumps(..., ensure_ascii=False)`, including spaces after `:` and `,`. */
export function toJson(value: unknown): string {
  try {
    return dumps(value, false);
  } catch (error) {
    if (error instanceof EncodeError) throw error;
    return dumps(value, true);
  }
}

export function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new EncodeError(message);
  }
  return value as Record<string, unknown>;
}

function toolCallId(toolCall: unknown): string {
  if (toolCall == null || typeof toolCall !== "object" || Array.isArray(toolCall)) return "";
  const call = toolCall as { id?: unknown; function?: unknown };
  if (typeof call.id === "string" && call.id) return call.id;
  if (call.function != null && typeof call.function === "object" && !Array.isArray(call.function)) {
    const id = (call.function as { id?: unknown }).id;
    return typeof id === "string" ? id : "";
  }
  return "";
}

export function sortToolResultsByCallOrder(messages: ChatMessage[]): ChatMessage[] {
  let lastToolCallOrder = new Map<string, number>();
  for (const msg of messages) {
    if (msg.role === "assistant" && pyTruthy(msg.tool_calls) && Array.isArray(msg.tool_calls)) {
      lastToolCallOrder = new Map();
      msg.tool_calls.forEach((tc, idx) => {
        const id = toolCallId(tc);
        if (id) lastToolCallOrder.set(id, idx);
      });
    } else if (msg.role === "user" && pyTruthy(msg.content_blocks) && Array.isArray(msg.content_blocks)) {
      const toolBlocks = msg.content_blocks.filter((block) => block?.type === "tool_result");
      if (toolBlocks.length > 1 && lastToolCallOrder.size > 0) {
        const sorted = [...toolBlocks].sort(
          (a, b) =>
            (lastToolCallOrder.get(a.tool_use_id ?? "") ?? 0) - (lastToolCallOrder.get(b.tool_use_id ?? "") ?? 0),
        );
        let sortedIdx = 0;
        msg.content_blocks = msg.content_blocks.map((block) => {
          if (block?.type === "tool_result") return sorted[sortedIdx++]!;
          return block;
        });
      }
    }
  }
  return messages;
}

function findLastUserIndex(messages: ChatMessage[]): number {
  for (let idx = messages.length - 1; idx >= 0; idx--) {
    const role = messages[idx]?.role;
    if (role === "user" || role === "developer") return idx;
  }
  return -1;
}

const keepRoles = new Set(["user", "system", "tool", "latest_reminder", "direct_search_results"]);

export function dropThinkingMessages(messages: ChatMessage[], lastUserIdx = findLastUserIndex(messages)): ChatMessage[] {
  const result: ChatMessage[] = [];
  messages.forEach((msg, idx) => {
    const role = msg.role;
    if ((role != null && keepRoles.has(role)) || idx >= lastUserIdx) {
      result.push(msg);
    } else if (role === "assistant") {
      const copy = { ...msg };
      delete copy.reasoning_content;
      result.push(copy);
    }
  });
  return result;
}
