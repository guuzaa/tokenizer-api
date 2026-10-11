//! DeepSeek V4.1 chat template.
//!
//! This follows `src/encoding/deepseek-flash.ts` and `src/encoding/shared.ts`, including
//! the two different "last user" scans and JavaScript truthiness where the TypeScript
//! uses `if (value)` rather than `pyTruthy`.

use crate::EncodeError;
use crate::value::{
    Value, is_nullish, js_string, js_truthy, parse_json, py_or_empty, py_truthy, py_truthy_opt,
    to_json,
};
use crate::wtf8::Wtf8;

pub const BOS_TOKEN: &str = "<｜begin▁of▁sentence｜>";
pub const EOS_TOKEN: &str = "<｜end▁of▁sentence｜>";
pub const THINKING_START_TOKEN: &str = "<think>";
pub const THINKING_END_TOKEN: &str = "</think>";
pub const DSML_TOKEN: &str = "｜DSML｜";
pub const USER_SP_TOKEN: &str = "<｜User｜>";
pub const ASSISTANT_SP_TOKEN: &str = "<｜Assistant｜>";
pub const LATEST_REMINDER_SP_TOKEN: &str = "<｜latest_reminder｜>";
pub const SYSTEM_SP_TOKEN: &str = "<｜System｜>";
const IMAGE_PLACEHOLDER: &str = "<｜deepseek_image｜>";

const TOOL_CALLS_BLOCK_NAME: &str = " calls";
const TOOL_CALL_TAG_NAME: &str = " invoke";
const TOOL_PARAMETER_TAG_NAME: &str = " parameter";

const RESPONSE_FORMAT_TEMPLATE: &str =
    "## Response Format:\n\nYou MUST strictly adhere to the following schema to reply:\n";

const TASKS: &[(&str, &str)] = &[
    ("action", "<｜action｜>"),
    ("query", "<｜query｜>"),
    ("authority", "<｜authority｜>"),
    ("domain", "<｜domain｜>"),
    ("title", "<｜title｜>"),
    ("read_url", "<｜read_url｜>"),
];

const KEEP_ROLES: &[&str] = &[
    "user",
    "system",
    "tool",
    "latest_reminder",
    "direct_search_results",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThinkingMode {
    Chat,
    Thinking,
}

pub struct EncodeOptions {
    pub thinking_mode: ThinkingMode,
    pub context: Vec<Value>,
    pub drop_thinking: bool,
    pub add_default_bos_token: bool,
    pub reasoning_effort: Value,
}

impl Default for EncodeOptions {
    fn default() -> Self {
        Self {
            thinking_mode: ThinkingMode::Thinking,
            context: Vec::new(),
            drop_thinking: true,
            add_default_bos_token: true,
            reasoning_effort: Value::Null,
        }
    }
}

pub fn render(body: &Value) -> Result<Wtf8, EncodeError> {
    let messages = match body.get("messages") {
        Some(Value::Array(items)) if !items.is_empty() => items.clone(),
        _ => return Err(EncodeError::new("messages must be a non-empty array")),
    };
    for (index, message) in messages.iter().enumerate() {
        if !message.is_object() {
            return Err(EncodeError::new(format!(
                "message {index} must be an object"
            )));
        }
    }
    let messages = with_request_tools(messages, body.get("tools"))?;
    let options = read_options(body)?;
    encode_messages(&messages, &options)
}

pub fn encode_messages(messages: &[Value], options: &EncodeOptions) -> Result<Wtf8, EncodeError> {
    let drop_thinking = options.drop_thinking;
    let reasoning_effort = &options.reasoning_effort;

    let context = if options.context.is_empty() {
        Vec::new()
    } else {
        process_image_messages(&options.context)?
    };
    let rendered = merge_tool_messages(&process_image_messages(messages)?)?;
    let mut combined = context.clone();
    combined.extend(rendered.iter().cloned());
    sort_tool_results(&mut combined)?;
    let mut rendered = combined.split_off(context.len());
    let context = if context.is_empty() {
        context
    } else {
        let mut merged = merge_tool_messages(&context)?;
        sort_tool_results(&mut merged)?;
        merged
    };

    let mut full_messages = context.clone();
    full_messages.append(&mut rendered);
    let mut prompt = Wtf8::new();
    if options.add_default_bos_token && context.is_empty() {
        prompt.push_str(BOS_TOKEN);
    }
    let mut effective_drop = drop_thinking;
    if full_messages
        .iter()
        .any(|message| py_truthy_opt(message.get("tools")))
    {
        effective_drop = false;
    }

    let (num_to_render, context_len) =
        if options.thinking_mode == ThinkingMode::Thinking && effective_drop {
            let last_user = find_last_render_index(&full_messages);
            full_messages = drop_thinking_messages(&full_messages, last_user);
            let dropped_context_len =
                drop_thinking_messages(&context, find_last_render_index(&context)).len();
            let num = full_messages.len() - dropped_context_len;
            (num, full_messages.len() - num)
        } else {
            let num = full_messages.len() - context.len();
            (num, context.len())
        };

    for index in 0..num_to_render {
        prompt.push_wtf8(&render_message(
            index + context_len,
            &full_messages,
            options.thinking_mode,
            effective_drop,
            reasoning_effort,
        )?);
    }
    Ok(prompt)
}

fn read_options(body: &Value) -> Result<EncodeOptions, EncodeError> {
    let thinking_mode = read_thinking_mode(body)?;
    if let Some(drop_thinking) = body.get("drop_thinking")
        && !matches!(drop_thinking, Value::Bool(_) | Value::Null)
    {
        return Err(EncodeError::new("drop_thinking must be a boolean"));
    }
    let effort = if body.contains_key("reasoning_effort") {
        body.get("reasoning_effort").cloned().unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    if !matches!(effort, Value::Null | Value::String(_) | Value::Number(_)) {
        return Err(invalid_effort(&effort));
    }
    Ok(EncodeOptions {
        thinking_mode,
        context: Vec::new(),
        drop_thinking: match body.get("drop_thinking") {
            Some(Value::Bool(value)) => *value,
            _ => true,
        },
        add_default_bos_token: true,
        reasoning_effort: effort,
    })
}

fn read_thinking_mode(body: &Value) -> Result<ThinkingMode, EncodeError> {
    let from_thinking = thinking_mode_from_type(body.get("thinking"))?;
    let from_mode = match body.get("thinking_mode") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) if text.eq_str("chat") => Some(ThinkingMode::Chat),
        Some(Value::String(text)) if text.eq_str("thinking") => Some(ThinkingMode::Thinking),
        Some(value) => {
            let mut message = Wtf8::from_text("Invalid thinking_mode `");
            message.push_wtf8(&js_string(Some(value)));
            message.push_str("`, should be \"chat\" or \"thinking\"");
            return Err(EncodeError::new(message));
        }
    };
    let from_enable = match body.get("enable_thinking") {
        None | Some(Value::Null) => None,
        Some(Value::Bool(true)) => Some(ThinkingMode::Thinking),
        Some(Value::Bool(false)) => Some(ThinkingMode::Chat),
        Some(_) => return Err(EncodeError::new("enable_thinking must be a boolean")),
    };
    let mut chosen = [from_thinking, from_mode, from_enable]
        .into_iter()
        .flatten();
    let Some(mode) = chosen.next() else {
        return Ok(ThinkingMode::Thinking);
    };
    if chosen.any(|item| item != mode) {
        return Err(EncodeError::new(
            "thinking, thinking_mode, and enable_thinking must select the same mode",
        ));
    }
    Ok(mode)
}

fn thinking_mode_from_type(value: Option<&Value>) -> Result<Option<ThinkingMode>, EncodeError> {
    let Some(value) = value else {
        return Ok(None);
    };
    if matches!(value, Value::Null) {
        return Ok(None);
    }
    if !value.is_object() {
        return Err(EncodeError::new(
            "thinking must be {\"type\":\"enabled\"} or {\"type\":\"disabled\"}",
        ));
    }
    match value.get("type").and_then(Value::as_str) {
        Some("enabled") => Ok(Some(ThinkingMode::Thinking)),
        Some("disabled") => Ok(Some(ThinkingMode::Chat)),
        _ => Err(EncodeError::new(
            "thinking.type must be \"enabled\" or \"disabled\"",
        )),
    }
}

fn with_request_tools(
    mut messages: Vec<Value>,
    tools: Option<&Value>,
) -> Result<Vec<Value>, EncodeError> {
    let Some(tools) = tools else {
        return Ok(messages);
    };
    if matches!(tools, Value::Null) {
        return Ok(messages);
    }
    let Value::Array(items) = tools else {
        return Err(EncodeError::new("tools must be a list"));
    };
    if items.is_empty() {
        return Ok(messages);
    }
    let tools = tools.clone();
    let first_is_system = messages
        .first()
        .and_then(|message| message.get("role"))
        .and_then(Value::as_str)
        == Some("system");
    if first_is_system {
        if !is_nullish(messages[0].get("tools")) {
            return Ok(messages);
        }
        messages[0].insert("tools", tools);
        return Ok(messages);
    }
    let system = Value::Object(vec![
        (
            Wtf8::from_text("role"),
            Value::String(Wtf8::from_text("system")),
        ),
        (Wtf8::from_text("content"), Value::String(Wtf8::new())),
        (Wtf8::from_text("tools"), tools),
    ]);
    messages.insert(0, system);
    Ok(messages)
}

fn invalid_effort(effort: &Value) -> EncodeError {
    let mut message = Wtf8::from_text("Invalid reasoning effort for deepseek_v41: ");
    message.push_wtf8(&js_string(Some(effort)));
    message.push_str(", should be int within [1,100] or ['low', 'high', 'max']");
    EncodeError::new(message)
}

fn effort_budget(effort: &Value) -> Result<i64, EncodeError> {
    let effort = if matches!(effort, Value::Null) {
        &Value::String(Wtf8::from_text("high"))
    } else {
        effort
    };
    if let Some(name) = effort.as_str() {
        let budget = match name {
            "low" => Some(50),
            "high" => Some(75),
            "max" => Some(100),
            _ => None,
        };
        if let Some(budget) = budget {
            return Ok(budget);
        }
    }
    if let Value::Number(number) = effort
        && number.is_finite()
        && number.fract() == 0.0
        && *number >= 1.0
        && *number <= 100.0
    {
        return Ok(*number as i64);
    }
    Err(invalid_effort(effort))
}

fn render_reasoning_effort(
    index: usize,
    mode: ThinkingMode,
    effort: &Value,
) -> Result<Wtf8, EncodeError> {
    let budget = effort_budget(effort)?;
    if index == 0 && mode == ThinkingMode::Thinking {
        Ok(Wtf8::from_text(&format!(
            "Reasoning Effort: {budget} (range 1-100, the higher the value, the more thorough the reasoning)\n\n"
        )))
    } else {
        Ok(Wtf8::new())
    }
}

/// Last `user`, or a non-leading `system`. Used when rendering and when dropping thinking.
fn find_last_render_index(messages: &[Value]) -> isize {
    for (index, message) in messages.iter().enumerate().rev() {
        let role = message.get("role").and_then(Value::as_str);
        if role == Some("user") || (role == Some("system") && index > 0) {
            return index as isize;
        }
    }
    -1
}

fn drop_thinking_messages(messages: &[Value], last_user_idx: isize) -> Vec<Value> {
    let mut result = Vec::new();
    for (index, message) in messages.iter().enumerate() {
        let role = message.get("role").and_then(Value::as_str);
        let kept =
            role.is_some_and(|role| KEEP_ROLES.contains(&role)) || index as isize >= last_user_idx;
        if kept {
            result.push(message.clone());
        } else if role == Some("assistant") {
            let mut copy = message.clone();
            copy.remove("reasoning_content");
            result.push(copy);
        }
    }
    result
}

fn tool_call_id(tool_call: &Value) -> Wtf8 {
    if !tool_call.is_object() {
        return Wtf8::new();
    }
    if let Some(id) = tool_call.get("id").and_then(Value::as_wtf8)
        && !id.is_empty()
    {
        return id.clone();
    }
    if let Some(function) = tool_call.get("function").filter(|value| value.is_object())
        && let Some(id) = function.get("id").and_then(Value::as_wtf8)
    {
        return id.clone();
    }
    Wtf8::new()
}

fn sort_tool_results(messages: &mut [Value]) -> Result<(), EncodeError> {
    let mut last_order: Vec<(Wtf8, usize)> = Vec::new();
    for message in messages.iter_mut() {
        let role = message.get("role").and_then(Value::as_str);
        if role == Some("assistant")
            && py_truthy_opt(message.get("tool_calls"))
            && message.get("tool_calls").is_some_and(Value::is_array)
        {
            last_order.clear();
            if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
                for (index, call) in calls.iter().enumerate() {
                    let id = tool_call_id(call);
                    if !id.is_empty() {
                        last_order.push((id, index));
                    }
                }
            }
        } else if role == Some("user")
            && py_truthy_opt(message.get("content_blocks"))
            && message.get("content_blocks").is_some_and(Value::is_array)
        {
            let Some(Value::Array(blocks)) = message.get("content_blocks").cloned() else {
                continue;
            };
            let tool_blocks: Vec<Value> = blocks
                .iter()
                .filter(|block| {
                    block
                        .get("type")
                        .and_then(Value::as_str)
                        .is_some_and(|kind| kind == "tool_result")
                })
                .cloned()
                .collect();
            if tool_blocks.len() > 1 && !last_order.is_empty() {
                let mut sorted = tool_blocks;
                sorted.sort_by_key(|block| order_key(block, &last_order));
                let mut sorted = sorted.into_iter();
                let rewritten = blocks
                    .into_iter()
                    .map(|block| {
                        if block
                            .get("type")
                            .and_then(Value::as_str)
                            .is_some_and(|kind| kind == "tool_result")
                        {
                            sorted.next().unwrap_or(block)
                        } else {
                            block
                        }
                    })
                    .collect();
                message.insert("content_blocks", Value::Array(rewritten));
            }
        }
    }
    Ok(())
}

fn order_key(block: &Value, order: &[(Wtf8, usize)]) -> usize {
    let Some(id) = block.get("tool_use_id").and_then(Value::as_wtf8) else {
        return 0;
    };
    order
        .iter()
        .find(|(key, _)| key == id)
        .map(|(_, index)| *index)
        .unwrap_or(0)
}

fn namespace_name(namespace: Option<&Value>) -> Result<Option<Wtf8>, EncodeError> {
    match namespace {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(name)) => Ok(Some(name.clone())),
        Some(value) if value.is_object() => match value.get("name") {
            Some(Value::String(name)) => Ok(Some(name.clone())),
            _ => Err(EncodeError::new("tool namespace is missing name")),
        },
        Some(_) => Err(EncodeError::new(
            "tool namespace must be a string or object",
        )),
    }
}

fn split_tool_name(
    name: &Wtf8,
    mut namespace: Option<Wtf8>,
) -> Result<(Option<Wtf8>, Wtf8), EncodeError> {
    if let Some(separator) = name.find_str("::") {
        let prefix = name.slice_units(0, Some(separator));
        if let Some(existing) = &namespace
            && existing != &prefix
        {
            let mut message = Wtf8::from_text("Conflicting tool namespaces: ");
            message.push_wtf8(existing);
            message.push_str(" != ");
            message.push_wtf8(&prefix);
            return Err(EncodeError::new(message));
        }
        namespace = Some(prefix);
        let name = name.slice_units(separator + 2, None);
        if name.find_str("::").is_some() {
            let mut message = Wtf8::from_text("Tool name must not contain '::': ");
            message.push_wtf8(&name);
            return Err(EncodeError::new(message));
        }
        if let Some(namespace) = &namespace
            && namespace.find_str("::").is_some()
        {
            let mut message = Wtf8::from_text("Tool namespace must not contain '::': ");
            message.push_wtf8(namespace);
            return Err(EncodeError::new(message));
        }
        return Ok((namespace, name));
    }
    if let Some(namespace) = &namespace
        && namespace.find_str("::").is_some()
    {
        let mut message = Wtf8::from_text("Tool namespace must not contain '::': ");
        message.push_wtf8(namespace);
        return Err(EncodeError::new(message));
    }
    Ok((namespace, name.clone()))
}

fn tool_name_for_encoding(tool: &Value) -> Result<Wtf8, EncodeError> {
    let Some(name) = tool.get("name").and_then(Value::as_wtf8) else {
        return Err(EncodeError::new("tool is missing a name"));
    };
    let (namespace, name) = split_tool_name(name, namespace_name(tool.get("namespace"))?)?;
    Ok(match namespace {
        Some(namespace) => {
            let mut full = namespace;
            full.push_str("::");
            full.push_wtf8(&name);
            full
        }
        None => name,
    })
}

fn as_record<'a>(value: &'a Value, message: &str) -> Result<&'a Value, EncodeError> {
    if value.is_object() {
        Ok(value)
    } else {
        Err(EncodeError::new(message))
    }
}

fn tools_from_openai(tools: &Value) -> Result<Vec<Value>, EncodeError> {
    let Some(tools) = tools.as_array() else {
        return Err(EncodeError::new("tools must be a list"));
    };
    let mut encoded = Vec::with_capacity(tools.len());
    for tool in tools {
        let record = as_record(tool, "tool is missing function")?;
        let function = as_record(
            record
                .get("function")
                .ok_or_else(|| EncodeError::new("tool is missing function"))?,
            "tool is missing function",
        )?;
        let mut copy = function.clone();
        if let Some(namespace) = record.get("namespace")
            && !matches!(namespace, Value::Null)
        {
            copy.insert("namespace", namespace.clone());
        }
        let name = tool_name_for_encoding(&copy)?;
        copy.insert("name", Value::String(name));
        let namespace = copy.get("namespace").cloned();
        copy.remove("namespace");
        if let Some(namespace) = namespace.as_ref().filter(|value| value.is_object()) {
            let description = namespace.get("description");
            if description.is_some_and(js_truthy) {
                let existing = copy.get("description");
                let mut text = js_string(description);
                text.push_str("\n");
                if existing.is_some_and(js_truthy) {
                    text.push_wtf8(&js_string(existing));
                }
                copy.insert("description", Value::String(text));
            }
        }
        encoded.push(copy);
    }
    Ok(encoded)
}

fn tool_calls_from_openai(tool_calls: &Value) -> Result<Vec<Value>, EncodeError> {
    let Some(tool_calls) = tool_calls.as_array() else {
        return Err(EncodeError::new("tool_calls must be a list"));
    };
    let mut encoded = Vec::with_capacity(tool_calls.len());
    for tool_call in tool_calls {
        let record = as_record(tool_call, "tool call is missing function")?;
        let function = as_record(
            record
                .get("function")
                .ok_or_else(|| EncodeError::new("tool call is missing function"))?,
            "tool call is missing function",
        )?;
        let name = function
            .get("name")
            .and_then(Value::as_wtf8)
            .cloned()
            .unwrap_or_default();
        let namespace = namespace_name(
            record
                .get("namespace")
                .or_else(|| function.get("namespace")),
        )?;
        let (namespace, name) = split_tool_name(&name, namespace)?;
        if name.is_empty() {
            return Err(EncodeError::new("tool call is missing a name"));
        }
        let arguments = function.get("arguments").cloned().unwrap_or(Value::Null);
        let mut call = Value::Object(vec![
            (Wtf8::from_text("name"), Value::String(name)),
            (Wtf8::from_text("arguments"), arguments),
        ]);
        if let Some(namespace) = namespace {
            call.insert("namespace", Value::String(namespace));
        }
        encoded.push(call);
    }
    Ok(encoded)
}

fn encode_arguments(tool_call: &Value) -> Result<Wtf8, EncodeError> {
    let original = tool_call.get("arguments").cloned().unwrap_or(Value::Null);
    let mut current = original.clone();
    for _ in 0..2 {
        let Some(text) = current.as_str() else {
            break;
        };
        match parse_json(text) {
            Some(parsed) => current = parsed,
            None => break,
        }
    }
    let args = if current.is_object() {
        current
    } else {
        Value::Object(vec![(Wtf8::from_text("arguments"), original)])
    };
    let mut parts = Vec::new();
    for (key, value) in args.as_object().into_iter().flatten() {
        let is_string = matches!(value, Value::String(_));
        let mut part = Wtf8::from_text("<");
        part.push_str(DSML_TOKEN);
        part.push_str(TOOL_PARAMETER_TAG_NAME);
        part.push_str(" name=\"");
        part.push_wtf8(key);
        part.push_str("\" string=\"");
        part.push_str(if is_string { "true" } else { "false" });
        part.push_str("\">");
        if let Value::String(text) = value {
            part.push_wtf8(text);
        } else {
            part.push_wtf8(&to_json(value)?);
        }
        part.push_str("</");
        part.push_str(DSML_TOKEN);
        part.push_str(TOOL_PARAMETER_TAG_NAME);
        part.push_str(">");
        parts.push(part);
    }
    let mut out = Wtf8::new();
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            out.push_str("\n");
        }
        out.push_wtf8(part);
    }
    Ok(out)
}

fn tools_template() -> Wtf8 {
    let mut out = Wtf8::from_text(
        "## Tools\n\nYou have access to a set of tools to help answer the user's question. You can invoke tools by writing a \"<",
    );
    out.push_str(DSML_TOKEN);
    out.push_str(TOOL_CALLS_BLOCK_NAME);
    out.push_str(">\" block like the following:\n\n<");
    out.push_str(DSML_TOKEN);
    out.push_str(TOOL_CALLS_BLOCK_NAME);
    out.push_str(">\n<");
    out.push_str(DSML_TOKEN);
    out.push_str(TOOL_CALL_TAG_NAME);
    out.push_str(" name=\"$TOOL_NAME\">\n<");
    out.push_str(DSML_TOKEN);
    out.push_str(TOOL_PARAMETER_TAG_NAME);
    out.push_str(" name=\"$PARAMETER_NAME\" string=\"true|false\">$PARAMETER_VALUE</");
    out.push_str(DSML_TOKEN);
    out.push_str(TOOL_PARAMETER_TAG_NAME);
    out.push_str(">\n...\n</");
    out.push_str(DSML_TOKEN);
    out.push_str(TOOL_CALL_TAG_NAME);
    out.push_str(">\n<");
    out.push_str(DSML_TOKEN);
    out.push_str(TOOL_CALL_TAG_NAME);
    out.push_str(" name=\"$TOOL_NAME2\">\n...\n</");
    out.push_str(DSML_TOKEN);
    out.push_str(TOOL_CALL_TAG_NAME);
    out.push_str(">\n</");
    out.push_str(DSML_TOKEN);
    out.push_str(TOOL_CALLS_BLOCK_NAME);
    out.push_str(">\n\nString parameters should be specified as is and set `string=\"true\"`. For all other types (numbers, booleans, arrays, objects), pass the value in JSON format and set `string=\"false\"`.\n\nIf thinking_mode is enabled (triggered by ");
    out.push_str(THINKING_START_TOKEN);
    out.push_str("), you MUST output your complete reasoning inside ");
    out.push_str(THINKING_START_TOKEN);
    out.push_str("...");
    out.push_str(THINKING_END_TOKEN);
    out.push_str(" BEFORE any tool calls or final response.\n\nOtherwise, output directly after ");
    out.push_str(THINKING_END_TOKEN);
    out.push_str(" with tool calls or final response.\n\n### Available Tool Schemas\n\n");
    out
}

fn render_tools(tools: &[Value]) -> Result<Wtf8, EncodeError> {
    let mut out = tools_template();
    for (index, tool) in tools.iter().enumerate() {
        if index > 0 {
            out.push_str("\n");
        }
        out.push_wtf8(&to_json(tool)?);
    }
    out.push_str("\n\nYou MUST strictly follow the above defined tool name and parameter schemas to invoke tool calls.\n");
    Ok(out)
}

fn assert_image_source(block: &Value) -> Result<(), EncodeError> {
    if block.get("type").and_then(Value::as_str) == Some("image_url") {
        let image_url = block.get("image_url");
        let url_ok = match image_url {
            Some(Value::String(url)) => !url.is_empty(),
            Some(value)
                if !matches!(value, Value::Null) && (value.is_object() || value.is_array()) =>
            {
                js_truthy(value.get("url").unwrap_or(&Value::Null))
            }
            _ => false,
        };
        if !url_ok {
            return Err(EncodeError::new(
                "Image block does not contain a valid source",
            ));
        }
        return Ok(());
    }
    let present = ["source", "url", "data"]
        .into_iter()
        .any(|key| block.get(key).is_some_and(js_truthy));
    if !present {
        return Err(EncodeError::new(
            "Image block does not contain a valid source",
        ));
    }
    Ok(())
}

fn process_image_blocks(blocks: &[Value]) -> Result<Vec<Value>, EncodeError> {
    let mut next = Vec::with_capacity(blocks.len());
    for block in blocks {
        if !block.is_object() {
            next.push(block.clone());
            continue;
        }
        let kind = block.get("type").and_then(Value::as_str);
        if kind == Some("image") || kind == Some("image_url") {
            assert_image_source(block)?;
            next.push(Value::Object(vec![
                (
                    Wtf8::from_text("type"),
                    Value::String(Wtf8::from_text("text")),
                ),
                (
                    Wtf8::from_text("text"),
                    Value::String(Wtf8::from_text(IMAGE_PLACEHOLDER)),
                ),
            ]));
        } else if kind == Some("tool_result") && block.get("content").is_some_and(Value::is_array) {
            let mut copy = block.clone();
            let content = process_image_blocks(
                block
                    .get("content")
                    .and_then(Value::as_array)
                    .unwrap_or(&[]),
            )?;
            copy.insert("content", Value::Array(content));
            next.push(copy);
        } else if kind == Some("text") {
            let text = py_or_empty(block.get("text"));
            if text.contains_str(IMAGE_PLACEHOLDER) {
                let mut message = Wtf8::from_text("Text block contains image placeholder '");
                message.push_str(IMAGE_PLACEHOLDER);
                message.push_str("': '");
                message.push_wtf8(&text.slice_units(0, Some(100)));
                message.push_str("'. Images should be separate content blocks.");
                return Err(EncodeError::new(message));
            }
            next.push(block.clone());
        } else {
            next.push(block.clone());
        }
    }
    Ok(next)
}

fn assert_no_image_token(message: &Value) -> Result<(), EncodeError> {
    if message
        .get("content")
        .and_then(Value::as_wtf8)
        .is_some_and(|text| text.contains_str(IMAGE_PLACEHOLDER))
    {
        let mut error = Wtf8::from_text("Message content contains image special token '");
        error.push_str(IMAGE_PLACEHOLDER);
        error.push_str("'. Images should be provided as image content blocks.");
        return Err(EncodeError::new(error));
    }
    if message
        .get("reasoning_content")
        .and_then(Value::as_wtf8)
        .is_some_and(|text| text.contains_str(IMAGE_PLACEHOLDER))
    {
        let mut error = Wtf8::from_text("reasoning_content contains image special token '");
        error.push_str(IMAGE_PLACEHOLDER);
        error.push_str("'");
        return Err(EncodeError::new(error));
    }
    Ok(())
}

fn process_image_messages(messages: &[Value]) -> Result<Vec<Value>, EncodeError> {
    let mut processed = Vec::with_capacity(messages.len());
    for original in messages {
        let mut message = original.clone();
        assert_no_image_token(&message)?;
        if message.get("content").is_some_and(Value::is_array)
            && is_nullish(message.get("content_blocks"))
        {
            let content = message
                .get("content")
                .cloned()
                .unwrap_or(Value::Array(Vec::new()));
            message.insert("content_blocks", content);
            message.remove("content");
        }
        if py_truthy_opt(message.get("content_blocks"))
            && message.get("content_blocks").is_some_and(Value::is_array)
        {
            let blocks = process_image_blocks(
                message
                    .get("content_blocks")
                    .and_then(Value::as_array)
                    .unwrap_or(&[]),
            )?;
            message.insert("content_blocks", Value::Array(blocks));
            if !matches!(message.get("content"), Some(Value::String(_))) {
                let texts: Vec<Wtf8> = message
                    .get("content_blocks")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter(|block| {
                        block.is_object()
                            && block.get("type").and_then(Value::as_str) == Some("text")
                    })
                    .map(|block| py_or_empty(block.get("text")))
                    .collect();
                let mut joined = Wtf8::new();
                for (index, text) in texts.iter().enumerate() {
                    if index > 0 {
                        joined.push_str("\n\n");
                    }
                    joined.push_wtf8(text);
                }
                message.insert("content", Value::String(joined));
            }
        }
        processed.push(message);
    }
    Ok(processed)
}

fn merge_tool_messages(messages: &[Value]) -> Result<Vec<Value>, EncodeError> {
    let mut merged = Vec::new();
    for original in messages {
        let message = original.clone();
        if message.get("role").and_then(Value::as_str) == Some("tool") {
            let tool_id = message
                .get("tool_call_id")
                .and_then(Value::as_wtf8)
                .cloned()
                .unwrap_or_default();
            let content = if message.get("content").is_none() {
                Value::String(Wtf8::new())
            } else {
                message.get("content").cloned().unwrap_or(Value::Null)
            };
            let tool_block = Value::Object(vec![
                (
                    Wtf8::from_text("type"),
                    Value::String(Wtf8::from_text("tool_result")),
                ),
                (Wtf8::from_text("tool_use_id"), Value::String(tool_id)),
                (Wtf8::from_text("content"), content),
            ]);
            if merged.last().is_some_and(|prev: &Value| {
                prev.get("role").and_then(Value::as_str) == Some("user")
                    && js_truthy_opt(prev.get("content_blocks"))
            }) {
                let prev = merged.last_mut().unwrap();
                if let Some(blocks) = prev.get_mut("content_blocks").and_then(Value::as_array_mut) {
                    blocks.push(tool_block);
                }
            } else {
                merged.push(Value::Object(vec![
                    (
                        Wtf8::from_text("role"),
                        Value::String(Wtf8::from_text("user")),
                    ),
                    (
                        Wtf8::from_text("content_blocks"),
                        Value::Array(vec![tool_block]),
                    ),
                ]));
            }
        } else if message.get("role").and_then(Value::as_str) == Some("user") {
            let content_blocks = if is_nullish(message.get("content_blocks")) {
                let text = match message.get("content") {
                    None | Some(Value::Null) => Value::String(Wtf8::new()),
                    Some(content) => content.clone(),
                };
                vec![Value::Object(vec![
                    (
                        Wtf8::from_text("type"),
                        Value::String(Wtf8::from_text("text")),
                    ),
                    (Wtf8::from_text("text"), text),
                ])]
            } else {
                message
                    .get("content_blocks")
                    .and_then(Value::as_array)
                    .unwrap_or(&[])
                    .to_vec()
            };
            let can_merge = merged.last().is_some_and(|prev: &Value| {
                prev.get("role").and_then(Value::as_str) == Some("user")
                    && js_truthy_opt(prev.get("content_blocks"))
                    && is_nullish(prev.get("task"))
            });
            if can_merge {
                let prev = merged.last_mut().unwrap();
                if let Some(blocks) = prev.get_mut("content_blocks").and_then(Value::as_array_mut) {
                    blocks.extend(content_blocks);
                }
            } else {
                let mut message = message;
                message.insert("content_blocks", Value::Array(content_blocks));
                merged.push(message);
            }
        } else {
            merged.push(message);
        }
    }
    Ok(merged)
}

fn js_truthy_opt(value: Option<&Value>) -> bool {
    value.is_some_and(js_truthy)
}

fn render_user_blocks(blocks: &[Value]) -> Result<Wtf8, EncodeError> {
    let mut parts = Vec::with_capacity(blocks.len());
    for block in blocks {
        let record = as_record(block, "content block must be an object")?;
        let kind = record.get("type");
        if kind.and_then(Value::as_str) == Some("text") {
            parts.push(py_or_empty(record.get("text")));
        } else if kind.and_then(Value::as_str) == Some("tool_result") {
            let tool_content = match record.get("content") {
                None | Some(Value::Null) => Value::String(Wtf8::new()),
                Some(Value::Array(items)) => {
                    let mut joined = Wtf8::new();
                    for (index, part) in items.iter().enumerate() {
                        let item = as_record(part, "tool result block must be an object")?;
                        let text = if item.get("type").and_then(Value::as_str) == Some("text") {
                            py_or_empty(item.get("text"))
                        } else {
                            let mut unsupported = Wtf8::from_text("[Unsupported ");
                            unsupported.push_wtf8(&js_string(item.get("type")));
                            unsupported.push_str("]");
                            unsupported
                        };
                        if index > 0 {
                            joined.push_str("\n\n");
                        }
                        joined.push_wtf8(&text);
                    }
                    Value::String(joined)
                }
                Some(other) => other.clone(),
            };
            let Some(text) = tool_content.as_wtf8() else {
                return Err(EncodeError::new("tool content must be a string"));
            };
            let mut rendered = Wtf8::from_text("<tool_result>");
            rendered.push_wtf8(text);
            rendered.push_str("</tool_result>");
            parts.push(rendered);
        } else {
            let mut unsupported = Wtf8::from_text("[Unsupported ");
            unsupported.push_wtf8(&js_string(kind));
            unsupported.push_str("]");
            parts.push(unsupported);
        }
    }
    let mut out = Wtf8::new();
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            out.push_str("\n\n");
        }
        out.push_wtf8(part);
    }
    Ok(out)
}

fn render_message(
    index: usize,
    messages: &[Value],
    thinking_mode: ThinkingMode,
    drop_thinking: bool,
    reasoning_effort: &Value,
) -> Result<Wtf8, EncodeError> {
    if index >= messages.len() {
        return Err(EncodeError::new("message index out of range"));
    }
    let message = &messages[index];
    let last_user_idx = find_last_render_index(messages);
    let role = message.get("role").and_then(Value::as_str);

    let mut tools = message.get("tools").cloned();
    let mut tool_calls = message.get("tool_calls").cloned();
    if tools.as_ref().is_some_and(py_truthy) {
        tools = Some(Value::Array(tools_from_openai(tools.as_ref().unwrap())?));
    }
    if tool_calls.as_ref().is_some_and(py_truthy) {
        tool_calls = Some(Value::Array(tool_calls_from_openai(
            tool_calls.as_ref().unwrap(),
        )?));
    }

    let effort_prompt = render_reasoning_effort(index, thinking_mode, reasoning_effort)?;
    let mut prompt = Wtf8::new();
    if index == 0 && (!effort_prompt.is_empty() || role == Some("system")) {
        prompt.push_str(SYSTEM_SP_TOKEN);
    }
    prompt.push_wtf8(&effort_prompt);

    if role == Some("system") {
        if index > 0 {
            prompt.push_str(SYSTEM_SP_TOKEN);
        }
        prompt.push_wtf8(&py_or_empty(message.get("content")));
        if tools.as_ref().is_some_and(py_truthy) {
            prompt.push_str("\n\n");
            prompt.push_wtf8(&render_tools(
                tools.as_ref().and_then(Value::as_array).unwrap_or(&[]),
            )?);
        }
        if py_truthy_opt(message.get("response_format")) {
            prompt.push_str("\n\n");
            prompt.push_str(RESPONSE_FORMAT_TEMPLATE);
            prompt.push_wtf8(&to_json(message.get("response_format").unwrap())?);
        }
    } else if role == Some("user") {
        prompt.push_str(USER_SP_TOKEN);
        if py_truthy_opt(message.get("content_blocks"))
            && message.get("content_blocks").is_some_and(Value::is_array)
        {
            prompt.push_wtf8(&render_user_blocks(
                message
                    .get("content_blocks")
                    .and_then(Value::as_array)
                    .unwrap_or(&[]),
            )?);
        } else {
            prompt.push_wtf8(&py_or_empty(message.get("content")));
        }
    } else if role == Some("latest_reminder") {
        prompt.push_str(LATEST_REMINDER_SP_TOKEN);
        prompt.push_wtf8(&py_or_empty(message.get("content")));
    } else if role == Some("tool") {
        return Err(EncodeError::new(
            "deepseek_v41 merges tool messages into user; please preprocess with merge_tool_messages()",
        ));
    } else if role == Some("assistant") {
        let mut tool_call_text = Wtf8::new();
        if tool_calls.as_ref().is_some_and(py_truthy) {
            let calls = tool_calls.as_ref().and_then(Value::as_array).unwrap_or(&[]);
            let mut rendered = Vec::with_capacity(calls.len());
            for call in calls {
                let name = tool_name_for_encoding(call)?;
                let args = encode_arguments(call)?;
                let mut one = Wtf8::from_text("<");
                one.push_str(DSML_TOKEN);
                one.push_str(TOOL_CALL_TAG_NAME);
                one.push_str(" name=\"");
                one.push_wtf8(&name);
                one.push_str("\">\n");
                one.push_wtf8(&args);
                one.push_str("\n</");
                one.push_str(DSML_TOKEN);
                one.push_str(TOOL_CALL_TAG_NAME);
                one.push_str(">");
                rendered.push(one);
            }
            tool_call_text.push_str("\n\n<");
            tool_call_text.push_str(DSML_TOKEN);
            tool_call_text.push_str(TOOL_CALLS_BLOCK_NAME);
            tool_call_text.push_str(">\n");
            for (index, call) in rendered.iter().enumerate() {
                if index > 0 {
                    tool_call_text.push_str("\n");
                }
                tool_call_text.push_wtf8(call);
            }
            tool_call_text.push_str("\n</");
            tool_call_text.push_str(DSML_TOKEN);
            tool_call_text.push_str(TOOL_CALLS_BLOCK_NAME);
            tool_call_text.push_str(">");
        }
        let prev_has_task = index > 0 && !is_nullish(messages[index - 1].get("task"));
        let mut thinking_part = Wtf8::new();
        if thinking_mode == ThinkingMode::Thinking
            && !prev_has_task
            && (!drop_thinking || index as isize > last_user_idx)
        {
            thinking_part = py_or_empty(message.get("reasoning_content"));
            thinking_part.push_str(THINKING_END_TOKEN);
        }
        prompt.push_wtf8(&thinking_part);
        prompt.push_wtf8(&py_or_empty(message.get("content")));
        prompt.push_wtf8(&tool_call_text);
        if !message.get("wo_eos").is_some_and(js_truthy) {
            prompt.push_str(EOS_TOKEN);
        }
    } else {
        let mut error = Wtf8::from_text("Unknown role: ");
        error.push_wtf8(&js_string(message.get("role")));
        return Err(EncodeError::new(error));
    }

    if index + 1 < messages.len() {
        let next_role = messages[index + 1].get("role").and_then(Value::as_str);
        if next_role != Some("assistant") && next_role != Some("latest_reminder") {
            return Ok(prompt);
        }
    }

    let task = message.get("task");
    if !is_nullish(task) {
        let task_name = task.and_then(Value::as_str);
        let Some(task_token) = task_name.and_then(|name| {
            TASKS
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, token)| *token)
        }) else {
            let mut error = Wtf8::from_text("Invalid task: '");
            error.push_wtf8(&js_string(task));
            error.push_str("'. Valid tasks are: ");
            error.push_str(
                &TASKS
                    .iter()
                    .map(|(name, _)| *name)
                    .collect::<Vec<_>>()
                    .join(", "),
            );
            return Err(EncodeError::new(error));
        };
        if task_name != Some("action") {
            prompt.push_str(task_token);
        } else {
            prompt.push_str(ASSISTANT_SP_TOKEN);
            prompt.push_str(if thinking_mode != ThinkingMode::Thinking {
                THINKING_END_TOKEN
            } else {
                THINKING_START_TOKEN
            });
            prompt.push_str(task_token);
        }
    } else if role == Some("user") || (role == Some("system") && index > 0) {
        prompt.push_str(ASSISTANT_SP_TOKEN);
        let open_think = thinking_mode == ThinkingMode::Thinking
            && (!drop_thinking || index as isize >= last_user_idx);
        prompt.push_str(if open_think {
            THINKING_START_TOKEN
        } else {
            THINKING_END_TOKEN
        });
    }

    Ok(prompt)
}
