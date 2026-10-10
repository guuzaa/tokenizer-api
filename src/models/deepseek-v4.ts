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

function readOptions(body: Record<string, unknown>): {
  thinkingMode: ThinkingMode;
  dropThinking: boolean;
  addDefaultBosToken: boolean;
  reasoningEffort: ReasoningEffort | null;
} {
  const thinkingMode = body.thinking_mode ?? "chat";
  if (thinkingMode !== "chat" && thinkingMode !== "thinking") {
    throw new EncodeError("thinking_mode must be \"chat\" or \"thinking\"");
  }
  if (body.drop_thinking != null && typeof body.drop_thinking !== "boolean") {
    throw new EncodeError("drop_thinking must be a boolean");
  }
  if (body.add_default_bos_token != null && typeof body.add_default_bos_token !== "boolean") {
    throw new EncodeError("add_default_bos_token must be a boolean");
  }
  const reasoningEffort = body.reasoning_effort ?? null;
  if (reasoningEffort != null && reasoningEffort !== "max" && reasoningEffort !== "high") {
    throw new EncodeError("reasoning_effort must be \"max\", \"high\", or null");
  }
  return {
    thinkingMode,
    dropThinking: typeof body.drop_thinking === "boolean" ? body.drop_thinking : true,
    addDefaultBosToken: typeof body.add_default_bos_token === "boolean" ? body.add_default_bos_token : true,
    reasoningEffort,
  };
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
    const messages = body.messages as ChatMessage[];
    assertTextMessages(messages);
    return encodeMessages(messages, readOptions(body));
  },
} satisfies ModelFamily;
