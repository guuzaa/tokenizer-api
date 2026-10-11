import {
  encodeMessages,
  EncodeError,
  type ChatMessage,
  type ThinkingMode,
} from "../encoding/deepseek-flash";
import { MAX_PROMPT_BYTES } from "../limits";
import type { ModelFamily } from "./types";
import { thinkingModeFromType, withRequestTools } from "./utils";

function readThinkingMode(body: Record<string, unknown>): ThinkingMode {
  const fromThinking = thinkingModeFromType(body.thinking);
  let fromMode: ThinkingMode | undefined;
  if (body.thinking_mode != null) {
    if (body.thinking_mode !== "chat" && body.thinking_mode !== "thinking") {
      throw new EncodeError(
        `Invalid thinking_mode \`${String(body.thinking_mode)}\`, should be "chat" or "thinking"`,
      );
    }
    fromMode = body.thinking_mode;
  }
  let fromEnable: ThinkingMode | undefined;
  if (body.enable_thinking != null) {
    if (typeof body.enable_thinking !== "boolean") throw new EncodeError("enable_thinking must be a boolean");
    fromEnable = body.enable_thinking ? "thinking" : "chat";
  }
  const chosen = [fromThinking, fromMode, fromEnable].filter((mode): mode is ThinkingMode => mode != null);
  const mode = chosen[0];
  if (mode == null) return "thinking";
  if (chosen.some((item) => item !== mode)) {
    throw new EncodeError("thinking, thinking_mode, and enable_thinking must select the same mode");
  }
  return mode;
}

function readOptions(body: Record<string, unknown>): {
  thinkingMode: ThinkingMode;
  dropThinking: boolean;
  reasoningEffort: string | number | null;
} {
  if (body.drop_thinking != null && typeof body.drop_thinking !== "boolean") {
    throw new EncodeError("drop_thinking must be a boolean");
  }
  const effort = "reasoning_effort" in body ? body.reasoning_effort : null;
  if (effort != null && typeof effort !== "string" && typeof effort !== "number") {
    throw new EncodeError(
      `Invalid reasoning effort for deepseek_v41: ${String(effort)}, should be int within [1,100] or ['low', 'high', 'max']`,
    );
  }
  return {
    thinkingMode: readThinkingMode(body),
    dropThinking: typeof body.drop_thinking === "boolean" ? body.drop_thinking : true,
    reasoningEffort: effort as string | number | null,
  };
}

export const deepseekFlash = {
  name: "deepseek-flash",
  maxPromptBytes: MAX_PROMPT_BYTES,
  matches(model: string): boolean {
    return model === "deepseek-flash" || model.startsWith("deepseek-v4.1-");
  },
  render(body: Record<string, unknown>): string {
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      throw new EncodeError("messages must be a non-empty array");
    }
    body.messages.forEach((message, index) => {
      if (message == null || typeof message !== "object" || Array.isArray(message)) {
        throw new EncodeError(`message ${index} must be an object`);
      }
    });
    return encodeMessages(withRequestTools(body.messages as ChatMessage[], body.tools), readOptions(body));
  },
} satisfies ModelFamily;
