use std::fs;
use std::time::Instant;

use tokenizers::Tokenizer;

fn main() {
    let json_path = std::env::args().nth(1).expect("tokenizer.json path");
    let cases_path = std::env::args().nth(2).expect("cases json path");
    let json = fs::read_to_string(&json_path).expect("read tokenizer");

    tokenizers::parallelism::set_parallelism(false);
    let started = Instant::now();
    let tokenizer = Tokenizer::from_bytes(json.as_bytes()).expect("parse tokenizer");
    eprintln!("from_bytes_ms {}", started.elapsed().as_secs_f64() * 1000.0);

    let sample = "你好，请用一句话介绍深度求索。".repeat(120);
    let started = Instant::now();
    let fast = tokenizer.encode_fast(sample.as_str(), false).expect("encode_fast");
    let full = tokenizer.encode(sample.as_str(), false).expect("encode");
    eprintln!("encode_fast_ms {}", started.elapsed().as_secs_f64() * 1000.0);
    eprintln!("ids_match {}", fast.get_ids() == full.get_ids());

    let cases: Vec<String> = serde_json::from_str(&fs::read_to_string(&cases_path).expect("cases")).expect("cases json");
    let mut out = Vec::with_capacity(cases.len());
    for text in &cases {
        match tokenizer.encode_fast(text.as_str(), false) {
            Ok(encoding) => out.push(serde_json::json!({ "ok": true, "ids": encoding.get_ids() })),
            Err(err) => out.push(serde_json::json!({ "ok": false, "error": err.to_string() })),
        }
    }
    println!("{}", serde_json::to_string(&out).expect("out"));
}
