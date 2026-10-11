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

type TaskName = keyof typeof taskTokens;
export const validTasks = new Set<string>(Object.keys(taskTokens));

export const responseFormatTemplate =
  "## Response Format:\n\nYou MUST strictly adhere to the following schema to reply:\n";

const toolCallsBlockName = "tool_calls";

const reasoningEffortMax =
  "Reasoning Effort: Absolute maximum with no shortcuts permitted.\n" +
  "You MUST be very thorough in your thinking and comprehensively decompose the problem to resolve the root cause, rigorously stress-testing your logic against all potential paths, edge cases, and adversarial scenarios.\n" +
  "Explicitly write out your entire deliberation process, documenting every intermediate step, considered alternative, and rejected hypothesis to ensure absolutely no assumption is left unchecked.\n\n";

const toolsTemplate = `## Tools

You have access to a set of tools to help answer the user's question. You can invoke tools by writing a "<${dsmlToken}tool_calls>" block like the following:

<${dsmlToken}tool_calls>
<${dsmlToken}invoke name="$TOOL_NAME">
<${dsmlToken}parameter name="$PARAMETER_NAME" string="true|false">$PARAMETER_VALUE</${dsmlToken}parameter>
...
</${dsmlToken}invoke>
<${dsmlToken}invoke name="$TOOL_NAME2">
...
</${dsmlToken}invoke>
</${dsmlToken}tool_calls>

String parameters should be specified as is and set \`string="true"\`. For all other types (numbers, booleans, arrays, objects), pass the value in JSON format and set \`string="false"\`.

If thinking_mode is enabled (triggered by ${thinkingStartToken}), you MUST output your complete reasoning inside ${thinkingStartToken}...${thinkingEndToken} BEFORE any tool calls or final response.

Otherwise, output directly after ${thinkingEndToken} with tool calls or final response.

### Available Tool Schemas

`;

export type ThinkingMode = "chat" | "thinking";
export type ReasoningEffort = "max" | "high";

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

export interface EncodeOptions {
  thinkingMode: ThinkingMode;
  context?: ChatMessage[];
  dropThinking?: boolean;
  addDefaultBosToken?: boolean;
  reasoningEffort?: ReasoningEffort | null;
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

function toolsFromOpenaiFormat(tools: unknown[]): Record<string, unknown>[] {
  return tools.map((tool) => {
    const record = asRecord(tool, "tool is missing function");
    return asRecord(record.function, "tool is missing function");
  });
}

function toolCallsFromOpenaiFormat(toolCalls: unknown[]): Array<{ name: unknown; arguments: unknown }> {
  return toolCalls.map((toolCall) => {
    const record = asRecord(toolCall, "tool call is missing function");
    const fn = asRecord(record.function, "tool call is missing function");
    return { name: fn.name, arguments: fn.arguments };
  });
}

function encodeArgumentsToDsml(toolCall: { name: unknown; arguments: unknown }): string {
  let args: Record<string, unknown>;
  if (typeof toolCall.arguments === "string") {
    try {
      const parsed: unknown = JSON.parse(toolCall.arguments);
      if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      } else {
        args = { arguments: toolCall.arguments };
      }
    } catch {
      args = { arguments: toolCall.arguments };
    }
  } else {
    args = { arguments: toolCall.arguments };
  }

  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    const isStr = typeof value === "string";
    const rendered = isStr ? value : toJson(value);
    parts.push(
      `<${dsmlToken}parameter name="${key}" string="${isStr ? "true" : "false"}">${rendered}</${dsmlToken}parameter>`,
    );
  }
  return parts.join("\n");
}

function renderTools(tools: Array<Record<string, unknown>>): string {
  const toolSchemas = tools.map((tool) => toJson(tool)).join("\n");
  return `${toolsTemplate}${toolSchemas}\n\nYou MUST strictly follow the above defined tool name and parameter schemas to invoke tool calls.\n`;
}

function findLastUserIndex(messages: ChatMessage[]): number {
  for (let idx = messages.length - 1; idx >= 0; idx--) {
    const role = messages[idx]?.role;
    if (role === "user" || role === "developer") return idx;
  }
  return -1;
}

function blockText(block: ContentBlock): string {
  if (block.type === "text") {
    return typeof block.text === "string" ? block.text : pyOrEmpty(block.text);
  }
  if (block.type === "tool_result") {
    let toolContent = block.content;
    if (Array.isArray(toolContent)) {
      const textParts = toolContent.map((part) => {
        const record = asRecord(part, "tool result block must be an object");
        if (record.type === "text") return pyOrEmpty(record.text);
        return `[Unsupported ${String(record.type)}]`;
      });
      toolContent = textParts.join("\n\n");
    }
    if (typeof toolContent !== "string") {
      // encoding_dsv4.py uses Python's str()/repr(). A JSON body cannot reproduce
      // that exactly: `22.0` and `22` are the same number after JSON.parse, and
      // CPython prints them differently inside a dict.
      throw new EncodeError("tool content must be a string");
    }
    return `<tool_result>${toolContent}</tool_result>`;
  }
  return `[Unsupported ${String(block.type)}]`;
}

function renderMessage(
  index: number,
  messages: ChatMessage[],
  thinkingMode: ThinkingMode,
  dropThinking: boolean,
  reasoningEffort: ReasoningEffort | null,
): string {
  if (index < 0 || index >= messages.length) {
    throw new EncodeError("message index out of range");
  }
  if (thinkingMode !== "chat" && thinkingMode !== "thinking") {
    throw new EncodeError(`Invalid thinking_mode \`${thinkingMode}\``);
  }
  if (reasoningEffort != null && reasoningEffort !== "max" && reasoningEffort !== "high") {
    throw new EncodeError(`Invalid reasoning effort: ${reasoningEffort}`);
  }

  let prompt = "";
  const msg = messages[index]!;
  const lastUserIdx = findLastUserIndex(messages);
  const role = msg.role;
  const responseFormat = msg.response_format;

  let tools = msg.tools;
  let toolCalls = msg.tool_calls;
  if (pyTruthy(tools)) {
    if (!Array.isArray(tools)) throw new EncodeError("tools must be a list");
    tools = toolsFromOpenaiFormat(tools);
  }
  if (pyTruthy(toolCalls)) {
    if (!Array.isArray(toolCalls)) throw new EncodeError("tool_calls must be a list");
    toolCalls = toolCallsFromOpenaiFormat(toolCalls);
  }

  if (index === 0 && thinkingMode === "thinking" && reasoningEffort === "max") {
    prompt += reasoningEffortMax;
  }

  if (role === "system") {
    prompt += pyOrEmpty(msg.content);
    if (pyTruthy(tools)) prompt += `\n\n${renderTools(tools as Array<Record<string, unknown>>)}`;
    if (pyTruthy(responseFormat)) prompt += `\n\n${responseFormatTemplate}${toJson(responseFormat)}`;
  } else if (role === "developer") {
    if (!pyTruthy(msg.content)) throw new EncodeError("Invalid message for role `developer`");
    let contentDeveloper = userSpToken + pyOrEmpty(msg.content);
    if (pyTruthy(tools)) contentDeveloper += `\n\n${renderTools(tools as Array<Record<string, unknown>>)}`;
    if (pyTruthy(responseFormat)) {
      contentDeveloper += `\n\n${responseFormatTemplate}${toJson(responseFormat)}`;
    }
    prompt += contentDeveloper;
  } else if (role === "user") {
    prompt += userSpToken;
    const contentBlocks = msg.content_blocks;
    if (pyTruthy(contentBlocks)) {
      if (!Array.isArray(contentBlocks)) throw new EncodeError("content_blocks must be a list");
      prompt += contentBlocks.map((block) => blockText(asRecord(block, "content block must be an object") as ContentBlock)).join("\n\n");
    } else {
      prompt += pyOrEmpty(msg.content);
    }
  } else if (role === "latest_reminder") {
    prompt += latestReminderSpToken + pyOrEmpty(msg.content);
  } else if (role === "tool") {
    throw new EncodeError("deepseek_v4 merges tool messages into user; please preprocess with merge_tool_messages()");
  } else if (role === "assistant") {
    let thinkingPart = "";
    let tcContent = "";
    if (pyTruthy(toolCalls)) {
      const calls = toolCalls as Array<{ name: unknown; arguments: unknown }>;
      const renderedCalls = calls.map((tc) => {
        if (typeof tc.name !== "string" || tc.name.length === 0) {
          throw new EncodeError("tool call is missing a name");
        }
        const args = encodeArgumentsToDsml(tc);
        return `<${dsmlToken}invoke name="${tc.name}">\n${args}\n</${dsmlToken}invoke>`;
      });
      tcContent += `\n\n<${dsmlToken}${toolCallsBlockName}>\n${renderedCalls.join("\n")}\n</${dsmlToken}${toolCallsBlockName}>`;
    }

    const summaryContent = pyOrEmpty(msg.content);
    const reasoning = pyOrEmpty(msg.reasoning_content);
    const prevHasTask = index - 1 >= 0 && messages[index - 1]?.task != null;
    if (thinkingMode === "thinking" && !prevHasTask) {
      if (!dropThinking || index > lastUserIdx) thinkingPart = reasoning + thinkingEndToken;
    }

    prompt += thinkingPart + summaryContent + tcContent;
    if (!msg.wo_eos) prompt += eosToken;
  } else {
    throw new EncodeError(`Unknown role: ${String(role)}`);
  }

  if (index + 1 < messages.length) {
    const nextRole = messages[index + 1]?.role;
    if (nextRole !== "assistant" && nextRole !== "latest_reminder") return prompt;
  }

  const task = msg.task;
  if (task != null) {
    if (!validTasks.has(task)) {
      throw new EncodeError(`Invalid task: '${task}'. Valid tasks are: ${Object.keys(taskTokens).join(", ")}`);
    }
    const taskSp = taskTokens[task as TaskName];
    if (task !== "action") {
      prompt += taskSp;
    } else {
      prompt += assistantSpToken;
      prompt += thinkingMode !== "thinking" ? thinkingEndToken : thinkingStartToken;
      prompt += taskSp;
    }
  } else if (role === "user" || role === "developer") {
    prompt += assistantSpToken;
    if (!dropThinking && thinkingMode === "thinking") prompt += thinkingStartToken;
    else if (dropThinking && thinkingMode === "thinking" && index >= lastUserIdx) prompt += thinkingStartToken;
    else prompt += thinkingEndToken;
  }

  return prompt;
}

function mergeToolMessages(messages: ChatMessage[]): ChatMessage[] {
  const merged: ChatMessage[] = [];
  for (const original of messages) {
    const msg = structuredClone(original);
    const role = msg.role;
    if (role === "tool") {
      const toolBlock: ContentBlock = {
        type: "tool_result",
        tool_use_id: typeof msg.tool_call_id === "string" ? msg.tool_call_id : "",
        content: msg.content === undefined ? "" : msg.content,
      };
      const prev = merged[merged.length - 1];
      if (prev?.role === "user" && prev.content_blocks) {
        prev.content_blocks.push(toolBlock);
      } else {
        merged.push({ role: "user", content_blocks: [toolBlock] });
      }
    } else if (role === "user") {
      const textBlock: ContentBlock = { type: "text", text: msg.content ?? "" };
      const prev = merged[merged.length - 1];
      if (prev?.role === "user" && prev.content_blocks && prev.task == null) {
        prev.content_blocks.push(textBlock);
      } else {
        const newMsg: ChatMessage = {
          role: "user",
          content: msg.content ?? "",
          content_blocks: [textBlock],
        };
        if ("task" in msg) newMsg.task = msg.task;
        if ("wo_eos" in msg) newMsg.wo_eos = msg.wo_eos;
        if ("mask" in msg) newMsg.mask = msg.mask;
        merged.push(newMsg);
      }
    } else {
      merged.push(msg);
    }
  }
  return merged;
}

export function toolCallId(toolCall: unknown): string {
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

export function encodeMessages(messages: ChatMessage[], options: EncodeOptions): string {
  const thinkingMode = options.thinkingMode;
  if (thinkingMode !== "chat" && thinkingMode !== "thinking") {
    throw new EncodeError(`Invalid thinking_mode \`${String(thinkingMode)}\``);
  }
  const dropThinking = options.dropThinking ?? true;
  const addDefaultBosToken = options.addDefaultBosToken ?? true;
  const reasoningEffort = options.reasoningEffort ?? null;

  let context = options.context ? [...options.context] : [];
  let rendered = mergeToolMessages(messages);
  rendered = sortToolResultsByCallOrder([...context, ...rendered]).slice(context.length);
  if (context.length > 0) {
    context = mergeToolMessages(context);
    context = sortToolResultsByCallOrder(context);
  }

  let fullMessages = [...context, ...rendered];
  let prompt = addDefaultBosToken && context.length === 0 ? bosToken : "";

  let effectiveDropThinking = dropThinking;
  if (fullMessages.some((msg) => pyTruthy(msg.tools))) effectiveDropThinking = false;

  let numToRender: number;
  let contextLen: number;
  if (thinkingMode === "thinking" && effectiveDropThinking) {
    fullMessages = dropThinkingMessages(fullMessages);
    const droppedContextLen = dropThinkingMessages(context).length;
    numToRender = fullMessages.length - droppedContextLen;
    contextLen = fullMessages.length - numToRender;
  } else {
    numToRender = rendered.length;
    contextLen = context.length;
  }

  for (let idx = 0; idx < numToRender; idx++) {
    prompt += renderMessage(idx + contextLen, fullMessages, thinkingMode, effectiveDropThinking, reasoningEffort);
  }
  return prompt;
}
