//! JSON values with JavaScript string and number behaviour.
//!
//! Objects keep insertion order. Numbers are f64, which is what `JSON.parse` produces.

use serde_json::Value as Json;

use crate::wtf8::Wtf8;

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Number(f64),
    String(Wtf8),
    Array(Vec<Value>),
    Object(Vec<(Wtf8, Value)>),
}

impl Value {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::String(value) => value.as_str(),
            _ => None,
        }
    }

    pub fn as_wtf8(&self) -> Option<&Wtf8> {
        match self {
            Value::String(value) => Some(value),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Value]> {
        match self {
            Value::Array(items) => Some(items),
            _ => None,
        }
    }

    pub fn as_array_mut(&mut self) -> Option<&mut Vec<Value>> {
        match self {
            Value::Array(items) => Some(items),
            _ => None,
        }
    }

    pub fn is_array(&self) -> bool {
        matches!(self, Value::Array(_))
    }

    pub fn is_object(&self) -> bool {
        matches!(self, Value::Object(_))
    }

    pub fn as_object(&self) -> Option<&[(Wtf8, Value)]> {
        match self {
            Value::Object(entries) => Some(entries),
            _ => None,
        }
    }

    pub fn as_object_mut(&mut self) -> Option<&mut Vec<(Wtf8, Value)>> {
        match self {
            Value::Object(entries) => Some(entries),
            _ => None,
        }
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.as_object()?
            .iter()
            .find(|(name, _)| name.eq_str(key))
            .map(|(_, value)| value)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut Value> {
        self.as_object_mut()?
            .iter_mut()
            .find(|(name, _)| name.eq_str(key))
            .map(|(_, value)| value)
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    pub fn insert(&mut self, key: &str, value: Value) {
        let Some(entries) = self.as_object_mut() else {
            return;
        };
        if let Some((_, slot)) = entries.iter_mut().find(|(name, _)| name.eq_str(key)) {
            *slot = value;
        } else {
            entries.push((Wtf8::from_text(key), value));
        }
    }

    pub fn remove(&mut self, key: &str) -> Option<Value> {
        let entries = self.as_object_mut()?;
        let index = entries.iter().position(|(name, _)| name.eq_str(key))?;
        Some(entries.remove(index).1)
    }
}

pub fn parse_json(input: &str) -> Option<Value> {
    serde_json::from_str::<Json>(input)
        .ok()
        .map(|value| from_serde(&value))
}

pub fn from_serde(value: &Json) -> Value {
    match value {
        Json::Null => Value::Null,
        Json::Bool(bit) => Value::Bool(*bit),
        Json::Number(number) => Value::Number(number.as_f64().unwrap_or(f64::NAN)),
        Json::String(text) => Value::String(Wtf8::from_text(text)),
        Json::Array(items) => Value::Array(items.iter().map(from_serde).collect()),
        Json::Object(entries) => Value::Object(
            entries
                .iter()
                .map(|(key, item)| (Wtf8::from_text(key), from_serde(item)))
                .collect(),
        ),
    }
}

/// Python `json.dumps(..., ensure_ascii=False)`, including spaces after `:` and `,`.
pub fn to_json(value: &Value) -> Result<Wtf8, super::EncodeError> {
    let mut out = Wtf8::new();
    dumps(value, &mut out)?;
    Ok(out)
}

fn dumps(value: &Value, out: &mut Wtf8) -> Result<(), super::EncodeError> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => out.push_str(&format_number(*number)),
        Value::String(text) => dump_string(text, out),
        Value::Array(items) => {
            out.push_str("[");
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push_str(", ");
                }
                dumps(item, out)?;
            }
            out.push_str("]");
        }
        Value::Object(entries) => {
            out.push_str("{");
            for (written, (key, item)) in entries.iter().enumerate() {
                if written > 0 {
                    out.push_str(", ");
                }
                dump_string(key, out);
                out.push_str(": ");
                dumps(item, out)?;
            }
            out.push_str("}");
        }
    }
    Ok(())
}

fn dump_string(value: &Wtf8, out: &mut Wtf8) {
    out.push_str("\"");
    for cp in value.code_points() {
        match cp {
            0x22 => out.push_str("\\\""),
            0x5C => out.push_str("\\\\"),
            0x08 => out.push_str("\\b"),
            0x0C => out.push_str("\\f"),
            0x0A => out.push_str("\\n"),
            0x0D => out.push_str("\\r"),
            0x09 => out.push_str("\\t"),
            cp if cp < 0x20 => out.push_str(&format!("\\u{cp:04x}")),
            cp => out.push_code_point(cp),
        }
    }
    out.push_str("\"");
}

/// `JSON.stringify` / `String(number)` for a JavaScript number.
///
/// `zmij` prints a shortest round-trip, which keeps a trailing `.0` on integers.
/// ECMA-262 `NumberToString` drops that and switches to plain digits while the
/// exponent stays inside `-6 < n <= 21`.
pub fn format_number(number: f64) -> String {
    if number.is_nan() {
        return "NaN".to_string();
    }
    if number.is_infinite() {
        return if number.is_sign_positive() {
            "Infinity".to_string()
        } else {
            "-Infinity".to_string()
        };
    }
    if number == 0.0 {
        return "0".to_string();
    }
    let mut buffer = zmij::Buffer::new();
    let printed = buffer.format_finite(number);
    let negative = printed.starts_with('-');
    let body = if negative { &printed[1..] } else { printed };
    let (coefficient, exp_text) = body.split_once(['e', 'E']).unwrap_or((body, ""));
    let exponent: i32 = if exp_text.is_empty() {
        0
    } else {
        exp_text.parse().unwrap_or(0)
    };
    let (whole, frac) = coefficient.split_once('.').unwrap_or((coefficient, ""));
    let mut digits = String::with_capacity(whole.len() + frac.len());
    digits.push_str(whole);
    digits.push_str(frac);
    let mut exp10 = exponent - i32::try_from(frac.len()).unwrap_or(0);
    while digits.len() > 1 && digits.starts_with('0') {
        digits.remove(0);
    }
    while digits.len() > 1 && digits.ends_with('0') {
        digits.pop();
        exp10 += 1;
    }
    let k = i32::try_from(digits.len()).unwrap_or(i32::MAX);
    let n = exp10 + k;
    let mut out = String::new();
    if negative {
        out.push('-');
    }
    if (k..=21).contains(&n) {
        out.push_str(&digits);
        for _ in 0..(n - k) {
            out.push('0');
        }
    } else if (1..=21).contains(&n) {
        let split = n as usize;
        out.push_str(&digits[..split]);
        out.push('.');
        out.push_str(&digits[split..]);
    } else if (-5..=0).contains(&n) {
        out.push_str("0.");
        for _ in 0..(-n) {
            out.push('0');
        }
        out.push_str(&digits);
    } else if k == 1 {
        out.push_str(&digits);
        push_exponent(&mut out, n - 1);
    } else {
        out.push(digits.chars().next().unwrap_or('0'));
        out.push('.');
        out.push_str(&digits[1..]);
        push_exponent(&mut out, n - 1);
    }
    out
}

fn push_exponent(out: &mut String, exponent: i32) {
    out.push('e');
    out.push(if exponent >= 0 { '+' } else { '-' });
    out.push_str(&exponent.unsigned_abs().to_string());
}

/// JavaScript truthiness. Empty arrays are truthy. `NaN` and `0` are not.
pub fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(bit) => *bit,
        Value::Number(number) => *number != 0.0 && !number.is_nan(),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// Python truthiness, which the encoder uses for `tools`, `content`, and `tool_calls`.
/// An empty array is falsy. An empty object is truthy. `NaN` is truthy.
pub fn py_truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::Bool(true) => true,
        Value::Number(number) => *number != 0.0,
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(_) => true,
    }
}

pub fn py_truthy_opt(value: Option<&Value>) -> bool {
    value.is_some_and(py_truthy)
}

/// JavaScript `String(value)`. A missing value is `"undefined"`, not `"null"`.
pub fn js_string(value: Option<&Value>) -> Wtf8 {
    match value {
        None => Wtf8::from_text("undefined"),
        Some(Value::Null) => Wtf8::from_text("null"),
        Some(Value::Bool(true)) => Wtf8::from_text("true"),
        Some(Value::Bool(false)) => Wtf8::from_text("false"),
        Some(Value::Number(number)) => Wtf8::from_text(&format_number(*number)),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => {
            let mut out = Wtf8::new();
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push_str(",");
                }
                if !matches!(item, Value::Null) {
                    out.push_wtf8(&js_string(Some(item)));
                }
            }
            out
        }
        Some(Value::Object(_)) => Wtf8::from_text("[object Object]"),
    }
}

pub fn py_or_empty(value: Option<&Value>) -> Wtf8 {
    match value {
        Some(value) if py_truthy(value) => match value {
            Value::String(text) => text.clone(),
            other => js_string(Some(other)),
        },
        _ => Wtf8::new(),
    }
}

pub fn is_nullish(value: Option<&Value>) -> bool {
    matches!(value, None | Some(Value::Null))
}
