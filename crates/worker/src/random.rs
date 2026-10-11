//! ahash asks getrandom for map seeds while the vocab is built. Workerd rejects
//! `crypto.getRandomValues` on a wasm-memory view, so copy through a JavaScript
//! buffer. It also rejects that call during Wasm `$start`. `Math.random` still
//! runs there and is a different value in each isolate, so startup uses it.
//! Any other failure returns an error and aborts init. Nothing writes a fixed seed.

use std::sync::atomic::{AtomicBool, Ordering};

use js_sys::{Reflect, Uint8Array};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = ["globalThis", "crypto"], js_name = getRandomValues, catch)]
    fn get_random_values(buf: &Uint8Array) -> Result<(), JsValue>;

    #[wasm_bindgen(js_namespace = ["globalThis", "Math"], js_name = random)]
    fn math_random() -> f64;
}

#[cfg(not(getrandom_backend = "custom"))]
compile_error!("build the worker with .cargo/config.toml so getrandom uses the custom backend");

static CRYPTO_BLOCKED: AtomicBool = AtomicBool::new(false);

#[unsafe(no_mangle)]
unsafe extern "Rust" fn __getrandom_v03_custom(
    dest: *mut u8,
    len: usize,
) -> Result<(), getrandom::Error> {
    fill(dest, len).map_err(|_| getrandom::Error::UNEXPECTED)
}

fn fill(dest: *mut u8, len: usize) -> Result<(), JsValue> {
    if !CRYPTO_BLOCKED.load(Ordering::Relaxed) {
        match fill_crypto(dest, len) {
            Ok(()) => return Ok(()),
            Err(err) if global_scope_block(&err) => {
                CRYPTO_BLOCKED.store(true, Ordering::Relaxed);
            }
            Err(err) => return Err(err),
        }
    }
    fill_math(dest, len);
    Ok(())
}

fn fill_crypto(dest: *mut u8, len: usize) -> Result<(), JsValue> {
    let mut offset = 0;
    while offset < len {
        let chunk = usize::min(len - offset, 65536);
        let buf = Uint8Array::new_with_length(chunk as u32);
        get_random_values(&buf)?;
        let slice = unsafe { std::slice::from_raw_parts_mut(dest.add(offset), chunk) };
        buf.copy_to(slice);
        offset += chunk;
    }
    Ok(())
}

fn fill_math(dest: *mut u8, len: usize) {
    let mut offset = 0;
    while offset < len {
        // `Math.random` has a 52-bit mantissa. Keep 48 bits, which are exact.
        let mut bits = (math_random() * (1u64 << 48) as f64) as u64;
        for _ in 0..6 {
            if offset >= len {
                break;
            }
            unsafe { dest.add(offset).write((bits & 0xff) as u8) };
            bits >>= 8;
            offset += 1;
        }
    }
}

fn global_scope_block(err: &JsValue) -> bool {
    message(err).contains("global scope")
}

fn message(err: &JsValue) -> String {
    if let Some(text) = err.as_string() {
        return text;
    }
    Reflect::get(err, &JsValue::from_str("message"))
        .ok()
        .and_then(|value| value.as_string())
        .unwrap_or_default()
}
