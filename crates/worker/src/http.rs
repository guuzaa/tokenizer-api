use encode::{Value, Wtf8, render};
use futures_util::StreamExt;
use js_sys::{Array, Function, JsString, Object, Reflect};
use sha2::{Digest, Sha256};
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;
use worker::*;

use crate::{count_tokens, log_failure};

const MAX_PROMPT_BYTES: u64 = 8 * 1024;
const MAX_BODY_BYTES: u64 = 48 * 1024;
const RATE_LIMIT_PERIOD: &str = "60";
const MAX_SAFE_INTEGER: u64 = (1_u64 << 53) - 1;

pub async fn handle(mut req: Request, env: Env) -> Result<Response> {
    if req.path() != "/v1/token/count" {
        return error(404, "not found", "not_found", None);
    }
    if req.method() != Method::Post {
        return error(405, "method not allowed", "method_not_allowed", None);
    }

    if let Some(denied) = enforce_access(&req, &env).await? {
        return Ok(denied);
    }

    let limits = request_limits(&env)?;
    let body = match read_body(&mut req, limits.max_body).await? {
        BodyRead::InvalidLength => {
            return error(400, "invalid content-length", "invalid_request_error", None);
        }
        BodyRead::TooLarge => {
            return error(
                413,
                &format!("request body exceeds {} bytes", limits.max_body),
                "request_too_large",
                None,
            );
        }
        BodyRead::Bytes(bytes) => bytes,
    };

    let payload = match parse_body(&body) {
        Ok(value) => value,
        Err(ParseBody::Invalid) => {
            return error(400, "invalid JSON body", "invalid_request_error", None);
        }
        Err(ParseBody::NotObject) => {
            return error(
                400,
                "body must be a JSON object",
                "invalid_request_error",
                None,
            );
        }
    };
    let model = match payload.get("model").and_then(Value::as_wtf8) {
        Some(name) if !name.is_empty() => name.clone(),
        _ => return error(400, "model is required", "invalid_request_error", None),
    };
    if !model_matches(&model) {
        let mut message = Wtf8::from_text("unsupported model: ");
        message.push_wtf8(&model);
        return error_wtf8(400, &message, "invalid_request_error", None);
    }

    let prompt = match render(&payload) {
        Ok(prompt) => prompt,
        Err(err) => return error_wtf8(400, err.message(), "invalid_request_error", None),
    };
    if prompt.len() as u64 > limits.max_prompt {
        return error(
            413,
            &format!("rendered prompt exceeds {} bytes", limits.max_prompt),
            "request_too_large",
            None,
        );
    }
    if !prompt.is_well_formed() {
        return error(
            400,
            "text contains an unpaired surrogate",
            "invalid_request_error",
            None,
        );
    }
    let text = prompt.as_str().expect("well-formed prompt");
    match count_tokens(text) {
        Ok(total) => json_bytes(
            200,
            format!(r#"{{"data":{{"total_tokens":{total}}}}}"#).into_bytes(),
            None,
        ),
        Err(err) => {
            log_failure("token count failed", &err.to_string());
            error(500, "failed to count tokens", "internal_error", None)
        }
    }
}

struct Limits {
    max_body: u64,
    max_prompt: u64,
}

fn request_limits(env: &Env) -> Result<Limits> {
    Ok(Limits {
        max_prompt: positive_limit(env_text(env, "MAX_PROMPT_BYTES")?, MAX_PROMPT_BYTES),
        max_body: positive_limit(env_text(env, "MAX_BODY_BYTES")?, MAX_BODY_BYTES),
    })
}

fn env_text(env: &Env, name: &str) -> Result<Option<String>> {
    match env.var(name) {
        Ok(value) => Ok(Some(value.to_string())),
        Err(_) => Ok(None),
    }
}

fn positive_limit(raw: Option<String>, fallback: u64) -> u64 {
    let Some(raw) = raw else {
        return fallback;
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() || !trimmed.bytes().all(|byte| byte.is_ascii_digit()) {
        return fallback;
    }
    match trimmed.parse::<u64>() {
        Ok(value) if value > 0 && value <= MAX_SAFE_INTEGER => value,
        _ => fallback,
    }
}

fn model_matches(model: &Wtf8) -> bool {
    model.eq_str("deepseek-flash")
        || model
            .as_str()
            .is_some_and(|name| name.starts_with("deepseek-v4.1-"))
}

enum BodyRead {
    Bytes(Vec<u8>),
    TooLarge,
    InvalidLength,
}

async fn read_body(req: &mut Request, max_body: u64) -> Result<BodyRead> {
    if let Some(declared) = req.headers().get("content-length")? {
        match declared_length(&declared, max_body) {
            Declared::Invalid => return Ok(BodyRead::InvalidLength),
            Declared::TooLarge => return Ok(BodyRead::TooLarge),
            Declared::Ok => {}
        }
    }
    let mut stream = match req.stream() {
        Ok(stream) => stream,
        Err(_) => return Ok(BodyRead::Bytes(Vec::new())),
    };
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if body.len() as u64 + chunk.len() as u64 > max_body {
            return Ok(BodyRead::TooLarge);
        }
        body.extend(chunk);
    }
    Ok(BodyRead::Bytes(body))
}

enum Declared {
    Ok,
    TooLarge,
    Invalid,
}

fn declared_length(declared: &str, max_body: u64) -> Declared {
    if declared.is_empty() || !declared.bytes().all(|byte| byte.is_ascii_digit()) {
        return Declared::Invalid;
    }
    let digits = declared.trim_start_matches('0');
    if digits.is_empty() {
        return Declared::Ok;
    }
    if digits.len() > 18 {
        return Declared::TooLarge;
    }
    match digits.parse::<u64>() {
        Ok(value) if value > max_body => Declared::TooLarge,
        Ok(_) => Declared::Ok,
        Err(_) => Declared::TooLarge,
    }
}

enum ParseBody {
    Invalid,
    NotObject,
}

fn parse_body(bytes: &[u8]) -> std::result::Result<Value, ParseBody> {
    let text = String::from_utf8_lossy(bytes);
    let parsed = js_sys::JSON::parse(&text).map_err(|_| ParseBody::Invalid)?;
    let value = from_js(&parsed);
    if value.is_object() {
        Ok(value)
    } else {
        Err(ParseBody::NotObject)
    }
}

fn from_js(value: &JsValue) -> Value {
    if value.is_null() || value.is_undefined() {
        return Value::Null;
    }
    if let Some(bit) = value.as_bool() {
        return Value::Bool(bit);
    }
    if let Some(number) = value.as_f64() {
        return Value::Number(number);
    }
    if value.is_string() {
        return Value::String(js_string_to_wtf8(&JsString::from(value.clone())));
    }
    if Array::is_array(value) {
        let array = Array::from(value);
        return Value::Array(array.iter().map(|item| from_js(&item)).collect());
    }
    if value.is_object() {
        let object = Object::from(value.clone());
        let keys = Object::keys(&object);
        let mut entries = Vec::with_capacity(keys.length() as usize);
        for key in keys.iter() {
            let name = js_string_to_wtf8(&JsString::from(key.clone()));
            let property = Reflect::get(value, &key).unwrap_or(JsValue::NULL);
            entries.push((name, from_js(&property)));
        }
        return Value::Object(entries);
    }
    Value::Null
}

fn js_string_to_wtf8(text: &JsString) -> Wtf8 {
    if js_is_well_formed(text)
        && let Some(utf8) = text.as_string()
    {
        return Wtf8::from_text(&utf8);
    }
    let len = text.length() as usize;
    let mut units = vec![0u16; len];
    for (index, unit) in units.iter_mut().enumerate() {
        *unit = text.char_code_at(index as u32) as u16;
    }
    Wtf8::from_utf16(&units)
}

fn js_is_well_formed(text: &JsString) -> bool {
    let Ok(method) = Reflect::get(text, &JsValue::from_str("isWellFormed")) else {
        return false;
    };
    let Ok(fun) = method.dyn_into::<Function>() else {
        return false;
    };
    fun.call0(text)
        .ok()
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

fn wtf8_to_js(text: &Wtf8) -> JsString {
    if let Some(utf8) = text.as_str() {
        JsString::from(utf8)
    } else {
        JsString::from_char_code(&text.to_utf16())
    }
}

async fn enforce_access(req: &Request, env: &Env) -> Result<Option<Response>> {
    let keys = configured_keys(env_text(env, "API_KEYS")?);
    let presented = req
        .headers()
        .get("authorization")?
        .as_deref()
        .and_then(bearer_token)
        .map(str::to_string);
    let authed = match presented {
        Some(token) if !keys.is_empty() && token_matches(&token, &keys) => Some(token),
        _ => None,
    };
    let limiter = env.rate_limiter("RATE_LIMITER")?;
    let outcome = limiter
        .limit(rate_limit_key(req, authed.as_deref())?)
        .await?;
    if !outcome.success {
        return error(
            429,
            "rate limit exceeded",
            "rate_limit_error",
            Some(RATE_LIMIT_PERIOD),
        )
        .map(Some);
    }
    if !keys.is_empty() && authed.is_none() {
        return error(401, "invalid api key", "authentication_error", None).map(Some);
    }
    Ok(None)
}

fn configured_keys(raw: Option<String>) -> Vec<String> {
    let Some(raw) = raw else {
        return Vec::new();
    };
    raw.split(',')
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_string)
        .collect()
}

fn bearer_token(header: &str) -> Option<&str> {
    let bytes = header.as_bytes();
    if bytes.len() < 7 || !bytes[..6].eq_ignore_ascii_case(b"bearer") {
        return None;
    }
    let rest = &header[6..];
    let token_start = rest.trim_start_matches(is_js_whitespace);
    if token_start.len() == rest.len() || token_start.is_empty() {
        return None;
    }
    let token_len = token_start
        .find(is_js_whitespace)
        .unwrap_or(token_start.len());
    let token = &token_start[..token_len];
    if token.is_empty() || !token_start[token_len..].chars().all(is_js_whitespace) {
        return None;
    }
    Some(token)
}

fn is_js_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\t' | '\n' | '\u{000B}' | '\u{000C}' | '\r' | ' ' | '\u{00A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

fn token_matches(token: &str, keys: &[String]) -> bool {
    let given = sha256(token.as_bytes());
    let mut matched = false;
    for key in keys {
        if constant_time_eq(&given, &sha256(key.as_bytes())) {
            matched = true;
        }
    }
    matched
}

fn rate_limit_key(req: &Request, authed: Option<&str>) -> Result<String> {
    if let Some(token) = authed {
        return Ok(format!("key:{}", hex(&sha256(token.as_bytes()))));
    }
    let ip = req.headers().get("CF-Connecting-IP")?;
    let ip = ip
        .as_deref()
        .filter(|ip| !ip.is_empty())
        .unwrap_or("unknown");
    Ok(format!("ip:{ip}"))
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().into()
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in left.iter().zip(right) {
        diff |= a ^ b;
    }
    diff == 0
}

fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn error(
    status: u16,
    message: &str,
    type_name: &str,
    retry_after: Option<&str>,
) -> Result<Response> {
    error_wtf8(status, &Wtf8::from_text(message), type_name, retry_after)
}

fn error_wtf8(
    status: u16,
    message: &Wtf8,
    type_name: &str,
    retry_after: Option<&str>,
) -> Result<Response> {
    let root = Object::new();
    let err = Object::new();
    Reflect::set(
        &err,
        &JsValue::from_str("message"),
        &wtf8_to_js(message).into(),
    )?;
    Reflect::set(
        &err,
        &JsValue::from_str("type"),
        &JsValue::from_str(type_name),
    )?;
    Reflect::set(&root, &JsValue::from_str("error"), &err)?;
    let text = js_sys::JSON::stringify(&root)?
        .as_string()
        .unwrap_or_default();
    json_bytes(status, text.into_bytes(), retry_after)
}

fn json_bytes(status: u16, bytes: Vec<u8>, retry_after: Option<&str>) -> Result<Response> {
    let headers = Headers::new();
    headers.set("content-type", "application/json; charset=utf-8")?;
    if let Some(retry_after) = retry_after {
        headers.set("retry-after", retry_after)?;
    }
    Ok(Response::from_bytes(bytes)?
        .with_status(status)
        .with_headers(headers))
}
