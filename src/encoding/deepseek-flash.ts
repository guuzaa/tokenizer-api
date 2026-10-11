import {
  EncodeError,
  asRecord,
  assistantSpToken,
  bosToken,
  dropThinkingMessages,
  dsmlToken,
  eosToken,
  latestReminderSpToken,
  pyOrEmpty,
  pyTruthy,
  responseFormatTemplate,
  sortToolResultsByCallOrder,
  taskTokens,
  thinkingEndToken,
  thinkingStartToken,
  toJson,
  userSpToken,
  validTasks,
  type ChatMessage,
  type ContentBlock,
  type ThinkingMode,
} from "./shared";

export { EncodeError, type ChatMessage, type ThinkingMode };

export type ReasoningEffortName = "low" | "high" | "max";

export interface FlashEncodeOptions {
  thinkingMode: ThinkingMode;
  context?: ChatMessage[];
  dropThinking?: boolean;
  addDefaultBosToken?: boolean;
  reasoningEffort?: string | number | null;
}

const systemSpToken = "<｜System｜>";
const imagePlaceholder = "<｜deepseek_image｜>";

const toolCallsBlockName = " calls";
const toolCallTagName = " invoke";
const toolParameterTagName = " parameter";

const reasoningEffortMap = { low: 50, high: 75, max: 100 } as const;

const toolsTemplate = `## Tools

You have access to a set of tools to help answer the user's question. You can invoke tools by writing a "<${dsmlToken}${toolCallsBlockName}>" block like the following:

<${dsmlToken}${toolCallsBlockName}>
<${dsmlToken}${toolCallTagName} name="$TOOL_NAME">
<${dsmlToken}${toolParameterTagName} name="$PARAMETER_NAME" string="true|false">$PARAMETER_VALUE</${dsmlToken}${toolParameterTagName}>
...
</${dsmlToken}${toolCallTagName}>
<${dsmlToken}${toolCallTagName} name="$TOOL_NAME2">
...
</${dsmlToken}${toolCallTagName}>
</${dsmlToken}${toolCallsBlockName}>

String parameters should be specified as is and set \`string="true"\`. For all other types (numbers, booleans, arrays, objects), pass the value in JSON format and set \`string="false"\`.

If thinking_mode is enabled (triggered by ${thinkingStartToken}), you MUST output your complete reasoning inside ${thinkingStartToken}...${thinkingEndToken} BEFORE any tool calls or final response.

Otherwise, output directly after ${thinkingEndToken} with tool calls or final response.

### Available Tool Schemas

`;

type TaskName = keyof typeof taskTokens;

function findLastUserIndex(messages: ChatMessage[]): number {
  for (let idx = messages.length - 1; idx >= 0; idx--) {
    const role = messages[idx]?.role;
    if (role === "user" || (role === "system" && idx > 0)) return idx;
  }
  return -1;
}

function splitToolName(name: string, namespace?: string | null): { namespace: string | null; name: string } {
  const separator = name.indexOf("::");
  if (separator !== -1) {
    const prefix = name.slice(0, separator);
    if (namespace != null && namespace !== prefix) {
      throw new EncodeError(`Conflicting tool namespaces: ${namespace} != ${prefix}`);
    }
    namespace = prefix;
    name = name.slice(separator + 2);
  }
  if (name.includes("::")) throw new EncodeError(`Tool name must not contain '::': ${name}`);
  if (namespace != null && namespace.includes("::")) {
    throw new EncodeError(`Tool namespace must not contain '::': ${namespace}`);
  }
  return { namespace: namespace ?? null, name };
}

function namespaceName(namespace: unknown): string | null {
  if (namespace == null) return null;
  if (typeof namespace === "string") return namespace;
  if (typeof namespace === "object" && !Array.isArray(namespace)) {
    const name = (namespace as { name?: unknown }).name;
    if (typeof name !== "string") throw new EncodeError("tool namespace is missing name");
    return name;
  }
  throw new EncodeError("tool namespace must be a string or object");
}

function toolNameForEncoding(tool: Record<string, unknown>): string {
  if (typeof tool.name !== "string") throw new EncodeError("tool is missing a name");
  const split = splitToolName(tool.name, namespaceName(tool.namespace));
  return split.namespace == null ? split.name : `${split.namespace}::${split.name}`;
}

function toolsFromOpenaiFormat(tools: unknown[]): Record<string, unknown>[] {
  if (!Array.isArray(tools)) throw new EncodeError("tools must be a list");
  return tools.map((tool) => {
    const record = asRecord(tool, "tool is missing function");
    const fn = asRecord(record.function, "tool is missing function");
    const copy: Record<string, unknown> = { ...fn };
    if (record.namespace != null) copy.namespace = record.namespace;
    copy.name = toolNameForEncoding(copy);
    const namespace = copy.namespace;
    delete copy.namespace;
    if (namespace != null && typeof namespace === "object" && !Array.isArray(namespace)) {
      const description = (namespace as { description?: unknown }).description;
      if (description) {
        const existing = copy.description;
        copy.description = `${String(description)}\n${existing ? String(existing) : ""}`;
      }
    }
    return copy;
  });
}

function toolCallsFromOpenaiFormat(toolCalls: unknown[]): Array<Record<string, unknown>> {
  if (!Array.isArray(toolCalls)) throw new EncodeError("tool_calls must be a list");
  return toolCalls.map((toolCall) => {
    const record = asRecord(toolCall, "tool call is missing function");
    const fn = asRecord(record.function, "tool call is missing function");
    const split = splitToolName(typeof fn.name === "string" ? fn.name : "", namespaceName(record.namespace ?? fn.namespace));
    if (!split.name) throw new EncodeError("tool call is missing a name");
    const call: Record<string, unknown> = { name: split.name, arguments: fn.arguments };
    if (split.namespace != null) call.namespace = split.namespace;
    return call;
  });
}

function encodeArgumentsToDsml(toolCall: { arguments: unknown }): string {
  let args: unknown = toolCall.arguments;
  if (args == null || typeof args !== "object" || Array.isArray(args)) {
    let current = args;
    for (let attempt = 0; attempt < 2 && typeof current === "string"; attempt++) {
      try {
        current = JSON.parse(current) as unknown;
      } catch {
        break;
      }
    }
    args =
      current != null && typeof current === "object" && !Array.isArray(current)
        ? current
        : { arguments: toolCall.arguments };
  }
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    const isStr = typeof value === "string";
    parts.push(
      `<${dsmlToken}${toolParameterTagName} name="${key}" string="${isStr ? "true" : "false"}">${isStr ? value : toJson(value)}</${dsmlToken}${toolParameterTagName}>`,
    );
  }
  return parts.join("\n");
}

function renderTools(tools: Array<Record<string, unknown>>): string {
  return `${toolsTemplate}${tools.map((tool) => toJson(tool)).join("\n")}\n\nYou MUST strictly follow the above defined tool name and parameter schemas to invoke tool calls.\n`;
}

function renderReasoningEffort(index: number, thinkingMode: ThinkingMode, effort: unknown): string {
  let budget: number;
  if (effort == null) effort = "high";
  if (typeof effort === "string" && Object.hasOwn(reasoningEffortMap, effort)) {
    budget = reasoningEffortMap[effort as ReasoningEffortName];
  } else if (typeof effort === "number" && Number.isInteger(effort) && effort >= 1 && effort <= 100) {
    budget = effort;
  } else {
    throw new EncodeError(
      `Invalid reasoning effort for deepseek_v41: ${String(effort)}, should be int within [1,100] or ['low', 'high', 'max']`,
    );
  }
  if (index === 0 && thinkingMode === "thinking") {
    return `Reasoning Effort: ${budget} (range 1-100, the higher the value, the more thorough the reasoning)\n\n`;
  }
  return "";
}

function assertImageSource(block: Record<string, unknown>): void {
  if (block.type === "image_url") {
    const imageUrl = block.image_url;
    const url = typeof imageUrl === "string" ? imageUrl : imageUrl != null && typeof imageUrl === "object" ? (imageUrl as { url?: unknown }).url : "";
    if (!url) throw new EncodeError("Image block does not contain a valid source");
    return;
  }
  if (!block.source && !block.url && !block.data) throw new EncodeError("Image block does not contain a valid source");
}

function processImageBlocks(blocks: unknown[]): ContentBlock[] {
  const next: ContentBlock[] = [];
  for (const block of blocks) {
    if (block == null || typeof block !== "object" || Array.isArray(block)) {
      next.push(block as ContentBlock);
      continue;
    }
    const record = block as Record<string, unknown>;
    if (record.type === "image" || record.type === "image_url") {
      assertImageSource(record);
      next.push({ type: "text", text: imagePlaceholder });
    } else if (record.type === "tool_result" && Array.isArray(record.content)) {
      next.push({ ...record, content: processImageBlocks(record.content) });
    } else if (record.type === "text") {
      const text = pyOrEmpty(record.text);
      if (text.includes(imagePlaceholder)) {
        throw new EncodeError(
          `Text block contains image placeholder '${imagePlaceholder}': '${text.slice(0, 100)}'. Images should be separate content blocks.`,
        );
      }
      next.push(record as ContentBlock);
    } else {
      next.push(record as ContentBlock);
    }
  }
  return next;
}

function assertNoImageToken(msg: ChatMessage): void {
  if (typeof msg.content === "string" && msg.content.includes(imagePlaceholder)) {
    throw new EncodeError(
      `Message content contains image special token '${imagePlaceholder}'. Images should be provided as image content blocks.`,
    );
  }
  if (typeof msg.reasoning_content === "string" && msg.reasoning_content.includes(imagePlaceholder)) {
    throw new EncodeError(`reasoning_content contains image special token '${imagePlaceholder}'`);
  }
}

function processImageMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((original) => {
    const msg = structuredClone(original);
    assertNoImageToken(msg);
    if (Array.isArray(msg.content) && msg.content_blocks == null) {
      msg.content_blocks = msg.content as ContentBlock[];
      delete msg.content;
    }
    if (pyTruthy(msg.content_blocks) && Array.isArray(msg.content_blocks)) {
      msg.content_blocks = processImageBlocks(msg.content_blocks);
      if (typeof msg.content !== "string") {
        msg.content = msg.content_blocks
          .filter((block) => block != null && typeof block === "object" && block.type === "text")
          .map((block) => pyOrEmpty(block.text))
          .join("\n\n");
      }
    }
    return msg;
  });
}

function mergeToolMessages(messages: ChatMessage[]): ChatMessage[] {
  const merged: ChatMessage[] = [];
  for (const original of messages) {
    const msg = structuredClone(original);
    if (msg.role === "tool") {
      const toolBlock: ContentBlock = {
        type: "tool_result",
        tool_use_id: typeof msg.tool_call_id === "string" ? msg.tool_call_id : "",
        content: msg.content === undefined ? "" : msg.content,
      };
      const prev = merged[merged.length - 1];
      if (prev?.role === "user" && prev.content_blocks) prev.content_blocks.push(toolBlock);
      else merged.push({ role: "user", content_blocks: [toolBlock] });
    } else if (msg.role === "user") {
      const contentBlocks = msg.content_blocks ?? [{ type: "text", text: msg.content ?? "" }];
      const prev = merged[merged.length - 1];
      if (prev?.role === "user" && prev.content_blocks && prev.task == null) prev.content_blocks.push(...contentBlocks);
      else {
        msg.content_blocks = contentBlocks;
        merged.push(msg);
      }
    } else {
      merged.push(msg);
    }
  }
  return merged;
}

function renderUserBlocks(blocks: unknown[]): string {
  return blocks
    .map((block) => {
      const record = asRecord(block, "content block must be an object");
      if (record.type === "text") return pyOrEmpty(record.text);
      if (record.type === "tool_result") {
        let toolContent = record.content ?? "";
        if (Array.isArray(toolContent)) {
          toolContent = toolContent
            .map((part) => {
              const item = asRecord(part, "tool result block must be an object");
              if (item.type === "text") return pyOrEmpty(item.text);
              return `[Unsupported ${String(item.type)}]`;
            })
            .join("\n\n");
        }
        if (typeof toolContent !== "string") throw new EncodeError("tool content must be a string");
        return `<tool_result>${toolContent}</tool_result>`;
      }
      return `[Unsupported ${String(record.type)}]`;
    })
    .join("\n\n");
}

function renderMessage(
  index: number,
  messages: ChatMessage[],
  thinkingMode: ThinkingMode,
  dropThinking: boolean,
  reasoningEffort: unknown,
): string {
  if (index < 0 || index >= messages.length) throw new EncodeError("message index out of range");
  const msg = messages[index]!;
  const lastUserIdx = findLastUserIndex(messages);
  const role = msg.role;

  let tools = msg.tools;
  let toolCalls = msg.tool_calls;
  if (pyTruthy(tools)) tools = toolsFromOpenaiFormat(tools as unknown[]);
  if (pyTruthy(toolCalls)) toolCalls = toolCallsFromOpenaiFormat(toolCalls as unknown[]);

  const reasoningEffortPrompt = renderReasoningEffort(index, thinkingMode, reasoningEffort);
  let prompt = index === 0 && (reasoningEffortPrompt || role === "system") ? systemSpToken : "";
  prompt += reasoningEffortPrompt;

  if (role === "system") {
    if (index > 0) prompt += systemSpToken;
    prompt += pyOrEmpty(msg.content);
    if (pyTruthy(tools)) prompt += `\n\n${renderTools(tools as Array<Record<string, unknown>>)}`;
    if (pyTruthy(msg.response_format)) prompt += `\n\n${responseFormatTemplate}${toJson(msg.response_format)}`;
  } else if (role === "user") {
    prompt += userSpToken;
    if (pyTruthy(msg.content_blocks) && Array.isArray(msg.content_blocks)) prompt += renderUserBlocks(msg.content_blocks);
    else prompt += pyOrEmpty(msg.content);
  } else if (role === "latest_reminder") {
    prompt += latestReminderSpToken + pyOrEmpty(msg.content);
  } else if (role === "tool") {
    throw new EncodeError("deepseek_v41 merges tool messages into user; please preprocess with merge_tool_messages()");
  } else if (role === "assistant") {
    let toolCallText = "";
    if (pyTruthy(toolCalls)) {
      const rendered = (toolCalls as Array<Record<string, unknown>>).map((call) => {
        const name = toolNameForEncoding(call);
        const args = encodeArgumentsToDsml(call as { arguments: unknown });
        return `<${dsmlToken}${toolCallTagName} name="${name}">\n${args}\n</${dsmlToken}${toolCallTagName}>`;
      });
      toolCallText = `\n\n<${dsmlToken}${toolCallsBlockName}>\n${rendered.join("\n")}\n</${dsmlToken}${toolCallsBlockName}>`;
    }
    const prevHasTask = index - 1 >= 0 && messages[index - 1]?.task != null;
    let thinkingPart = "";
    if (thinkingMode === "thinking" && !prevHasTask && (!dropThinking || index > lastUserIdx)) {
      thinkingPart = pyOrEmpty(msg.reasoning_content) + thinkingEndToken;
    }
    prompt += thinkingPart + pyOrEmpty(msg.content) + toolCallText;
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
    if (task !== "action") prompt += taskSp;
    else {
      prompt += assistantSpToken;
      prompt += thinkingMode !== "thinking" ? thinkingEndToken : thinkingStartToken;
      prompt += taskSp;
    }
  } else if (role === "user" || (role === "system" && index > 0)) {
    prompt += assistantSpToken;
    if (!dropThinking && thinkingMode === "thinking") prompt += thinkingStartToken;
    else if (dropThinking && thinkingMode === "thinking" && index >= lastUserIdx) prompt += thinkingStartToken;
    else prompt += thinkingEndToken;
  }

  return prompt;
}

export function encodeMessages(messages: ChatMessage[], options: FlashEncodeOptions): string {
  const thinkingMode = options.thinkingMode;
  if (thinkingMode !== "chat" && thinkingMode !== "thinking") {
    throw new EncodeError(`Invalid thinking_mode \`${String(thinkingMode)}\``);
  }
  const dropThinking = options.dropThinking ?? true;
  const addDefaultBosToken = options.addDefaultBosToken ?? true;
  const reasoningEffort = options.reasoningEffort ?? null;

  let context = options.context?.length ? processImageMessages(options.context) : [];
  let rendered = mergeToolMessages(processImageMessages(messages));
  rendered = sortToolResultsByCallOrder([...context, ...rendered]).slice(context.length);
  if (context.length > 0) {
    context = sortToolResultsByCallOrder(mergeToolMessages(context));
  }

  let fullMessages = [...context, ...rendered];
  let prompt = addDefaultBosToken && context.length === 0 ? bosToken : "";
  let effectiveDropThinking = dropThinking;
  if (fullMessages.some((msg) => pyTruthy(msg.tools))) effectiveDropThinking = false;

  let numToRender: number;
  let contextLen: number;
  if (thinkingMode === "thinking" && effectiveDropThinking) {
    fullMessages = dropThinkingMessages(fullMessages, findLastUserIndex(fullMessages));
    const droppedContextLen = dropThinkingMessages(context, findLastUserIndex(context)).length;
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
