import {
  encodeMessages,
  EncodeError,
  type ChatMessage,
  type ReasoningEffort,
  type ThinkingMode,
} from "../encoding/deepseek-v4";
import { MAX_PROMPT_BYTES } from "../limits";
import type { ModelFamily } from "./types";

function assertTextMessages(messages: ChatMessage[]): void {
  messages.forEach((message, index) => {
    if (message == null || typeof message !== "object" || Array.isArray(message)) {
      throw new EncodeError(`message ${index} must be an object`);
    }
    if (message.role === "tool") {
      if (typeof message.content !== "string" && !Array.isArray(message.content)) {
        throw new EncodeError(`message ${index} content must be a string`);
      }
      return;
    }
    if (message.content != null && typeof message.content !== "string") {
      throw new EncodeError(`message ${index} content must be a string`);
    }
  });
}

/** DeepSeek maps these onto the two prefixes this template actually renders. */
const reasoningEffortAliases = {
  max: "max",
  xhigh: "max",
  high: "high",
  medium: "high",
  low: "high",
} as const satisfies Record<string, ReasoningEffort>;

function thinkingModeFromType(value: unknown): ThinkingMode | undefined {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new EncodeError('thinking must be {"type":"enabled"} or {"type":"disabled"}');
  }
  const type = (value as { type?: unknown }).type;
  if (type === "enabled") return "thinking";
  if (type === "disabled") return "chat";
  throw new EncodeError('thinking.type must be "enabled" or "disabled"');
}

function readThinkingMode(body: Record<string, unknown>): ThinkingMode {
  const fromThinking = thinkingModeFromType(body.thinking);
  const thinkingMode = body.thinking_mode;
  if (thinkingMode != null && thinkingMode !== "chat" && thinkingMode !== "thinking") {
    throw new EncodeError('thinking_mode must be "chat" or "thinking"');
  }
  if (fromThinking != null && thinkingMode != null && fromThinking !== thinkingMode) {
    throw new EncodeError("thinking and thinking_mode must select the same mode");
  }
  return fromThinking ?? (thinkingMode as ThinkingMode | undefined) ?? "chat";
}

function readReasoningEffort(value: unknown): ReasoningEffort | null {
  if (value == null) return null;
  if (typeof value === "string" && Object.hasOwn(reasoningEffortAliases, value)) {
    return reasoningEffortAliases[value as keyof typeof reasoningEffortAliases];
  }
  throw new EncodeError('reasoning_effort must be "low", "medium", "high", "max", "xhigh", or null');
}

function readOptions(body: Record<string, unknown>): {
  thinkingMode: ThinkingMode;
  dropThinking: boolean;
  addDefaultBosToken: boolean;
  reasoningEffort: ReasoningEffort | null;
} {
  if (body.drop_thinking != null && typeof body.drop_thinking !== "boolean") {
    throw new EncodeError("drop_thinking must be a boolean");
  }
  if (body.add_default_bos_token != null && typeof body.add_default_bos_token !== "boolean") {
    throw new EncodeError("add_default_bos_token must be a boolean");
  }
  return {
    thinkingMode: readThinkingMode(body),
    dropThinking: typeof body.drop_thinking === "boolean" ? body.drop_thinking : true,
    addDefaultBosToken: typeof body.add_default_bos_token === "boolean" ? body.add_default_bos_token : true,
    reasoningEffort: readReasoningEffort(body.reasoning_effort),
  };
}

function withRequestTools(messages: ChatMessage[], tools: unknown): ChatMessage[] {
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

export const deepseekV4 = {
  name: "deepseek-v4",
  maxPromptBytes: MAX_PROMPT_BYTES,
  matches(model: string): boolean {
    return model === "deepseek-v4" || model.startsWith("deepseek-v4-");
  },
  render(body: Record<string, unknown>): string {
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      throw new EncodeError("messages must be a non-empty array");
    }
    const messages = withRequestTools(body.messages as ChatMessage[], body.tools);
    assertTextMessages(messages);
    return encodeMessages(messages, readOptions(body));
  },
} satisfies ModelFamily;
