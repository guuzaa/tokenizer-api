mod http;
mod random;

use std::sync::OnceLock;

use tokenizers::Tokenizer;
use wasm_bindgen::prelude::*;
use worker::*;

use crate::http::handle;

const TOKENIZER_JSON: &[u8] = include_bytes!("../../../config/deepseek-v4.1/tokenizer.json");

static TOKENIZER: OnceLock<Tokenizer> = OnceLock::new();

fn tokenizer() -> &'static Tokenizer {
    TOKENIZER.get_or_init(|| {
        tokenizers::parallelism::set_parallelism(false);
        Tokenizer::from_bytes(TOKENIZER_JSON).expect("deepseek-v4.1 tokenizer.json")
    })
}

pub fn count_tokens(text: &str) -> Result<u32> {
    let encoding = tokenizer()
        .encode_fast(text, false)
        .map_err(|err| Error::RustError(err.to_string()))?;
    Ok(encoding.len() as u32)
}

#[event(start)]
fn start() {
    console_error_panic_hook::set_once();
    // The vocab build is the one-time cost. Do it inside the startup budget so a
    // request stays under the free-plan CPU limit. Four max-size encodes follow,
    // matching the previous worker, so the first request is not the slow one.
    tokenizer();
    warmup();
}

fn warmup() {
    let body = encode::Value::Object(vec![(
        encode::Wtf8::from_text("messages"),
        encode::Value::Array(vec![encode::Value::Object(vec![
            (
                encode::Wtf8::from_text("role"),
                encode::Value::String(encode::Wtf8::from_text("user")),
            ),
            (
                encode::Wtf8::from_text("content"),
                encode::Value::String(encode::Wtf8::from_text(&"7".repeat(8192))),
            ),
        ])]),
    )]);
    for _ in 0..4 {
        if let Ok(prompt) = encode::render(&body)
            && let Some(text) = prompt.as_str()
        {
            let _ = count_tokens(text);
        }
    }
}

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    handle(req, env).await
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn error(message: &str);
}

pub fn log_failure(context: &str, detail: &str) {
    error(&format!(r#"{{"message":"{context}","error":"{detail}"}}"#));
}
