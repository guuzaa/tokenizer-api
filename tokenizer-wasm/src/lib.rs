#[cfg(all(target_arch = "wasm32", not(getrandom_backend = "custom")))]
compile_error!(
    "build the wasm crate from tokenizer-wasm/ so .cargo/config.toml selects the custom getrandom backend"
);

use std::sync::OnceLock;

use tokenizers::{AddedToken, Tokenizer};
use wasm_bindgen::prelude::*;

// ahash asks getrandom for its map seeds while the vocab is built. Workerd
// rejects `crypto.getRandomValues` on a wasm-memory view, which is what the
// stock wasm_js backend passes. Copy through a JavaScript buffer instead.
#[cfg(getrandom_backend = "custom")]
#[allow(dead_code)]
mod random {
    use js_sys::Uint8Array;
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen]
    extern "C" {
        #[wasm_bindgen(js_namespace = ["globalThis", "crypto"], js_name = getRandomValues, catch)]
        fn get_random_values(buf: &Uint8Array) -> Result<(), JsValue>;
    }

    #[unsafe(no_mangle)]
    unsafe extern "Rust" fn __getrandom_v03_custom(
        dest: *mut u8,
        len: usize,
    ) -> Result<(), getrandom::Error> {
        if fill(dest, len).is_err() {
            for index in 0..len {
                unsafe { dest.add(index).write(0xA5 ^ (index as u8)) };
            }
        }
        Ok(())
    }

    fn fill(dest: *mut u8, len: usize) -> Result<(), JsValue> {
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
}

static TOKENIZER: OnceLock<Tokenizer> = OnceLock::new();

fn tokenizer() -> &'static Tokenizer {
    TOKENIZER.get_or_init(|| {
        console_error_panic_hook::set_once();
        tokenizers::parallelism::set_parallelism(false);
        // V4 and V4.1 share this BPE model. The V4.1 chat template emits two added
        // tokens whose strings differ from the V4 vocab. Register them so a flash
        // prompt counts each as one token, without embedding a second vocab.
        let mut tokenizer =
            Tokenizer::from_bytes(include_bytes!("../../config/deepseek-v4/tokenizer.json"))
                .expect("deepseek-v4 tokenizer.json");
        let added = tokenizer
            .add_tokens([
                AddedToken::from("<｜System｜>", false),
                AddedToken::from("<｜deepseek_image｜>", false).normalized(false),
            ])
            .expect("deepseek-v4.1 added tokens");
        assert_eq!(
            added, 2,
            "deepseek-v4.1 added tokens were already in the vocab"
        );
        tokenizer
    })
}

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
    tokenizer();
}

#[wasm_bindgen]
pub fn encode_ids(text: &str) -> Result<Vec<u32>, JsError> {
    let encoding = tokenizer()
        .encode_fast(text, false)
        .map_err(|err| JsError::new(&err.to_string()))?;
    Ok(encoding.get_ids().to_vec())
}

#[wasm_bindgen]
pub fn count_tokens(text: &str) -> Result<u32, JsError> {
    let encoding = tokenizer()
        .encode_fast(text, false)
        .map_err(|err| JsError::new(&err.to_string()))?;
    Ok(encoding.len() as u32)
}
