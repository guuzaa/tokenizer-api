import {
  EncodeError,
  type ChatMessage,
  type ThinkingMode,
} from "../encoding/shared";

export function thinkingModeFromType(value: unknown): ThinkingMode | undefined {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new EncodeError('thinking must be {"type":"enabled"} or {"type":"disabled"}');
  }
  const type = (value as { type?: unknown }).type;
  if (type === "enabled") return "thinking";
  if (type === "disabled") return "chat";
  throw new EncodeError('thinking.type must be "enabled" or "disabled"');
}

export function withRequestTools(messages: ChatMessage[], tools: unknown): ChatMessage[] {
  if (tools == null) return messages;
  if (!Array.isArray(tools)) throw new EncodeError("tools must be a list");
  if (tools.length === 0) return messages;
  const first = messages[0];
  if (first?.role === "system") {
    if (first.tools != null) return messages;
    return [{ ...first, tools }, ...messages.slice(1)];
  }
  return [{ role: "system", content: "", tools }, ...messages];
}
