mod flash;
mod value;
mod wtf8;

pub use flash::{EncodeOptions, ThinkingMode, encode_messages, render};
pub use value::{Value, format_number, parse_json, to_json};
pub use wtf8::Wtf8;

#[derive(Debug, Clone)]
pub struct EncodeError {
    message: Wtf8,
}

impl EncodeError {
    fn new(message: impl Into<Wtf8>) -> Self {
        Self {
            message: message.into(),
        }
    }

    pub fn message(&self) -> &Wtf8 {
        &self.message
    }
}

impl std::fmt::Display for EncodeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message.to_string_lossy())
    }
}

impl std::error::Error for EncodeError {}
