use std::fs;
use std::path::PathBuf;
use std::process::Command;

use encode::{EncodeOptions, ThinkingMode, Value, Wtf8, encode_messages, parse_json, render};

fn data_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/test_data/deepseek-v4.1")
}

fn request_body(raw: &Value) -> Value {
    if raw.is_array() {
        Value::Object(vec![
            (Wtf8::from_text("messages"), raw.clone()),
            (
                Wtf8::from_text("thinking_mode"),
                Value::String(Wtf8::from_text("chat")),
            ),
        ])
    } else {
        raw.clone()
    }
}

#[test]
fn official_fixtures_match() {
    let dir = data_dir();
    for id in 1..=5 {
        let input = fs::read_to_string(dir.join(format!("test_input_{id}.json"))).unwrap();
        let expected = fs::read_to_string(dir.join(format!("test_output_{id}.txt"))).unwrap();
        let body = request_body(&parse_json(&input).unwrap());
        let actual = render(&body).unwrap_or_else(|error| panic!("input {id}: {error}"));
        let actual = actual
            .as_str()
            .unwrap_or_else(|| panic!("input {id} was not well-formed"));
        assert_eq!(actual, expected, "test_input_{id}");
    }
}

#[test]
fn defaults_and_errors_match_the_typescript_encoder() {
    let hi = parse_json(r#"{"messages":[{"role":"user","content":"hi"}]}"#).unwrap();
    let thinking = render(&hi).unwrap();
    let thinking = thinking.as_str().unwrap();
    assert!(thinking.contains("Reasoning Effort: 75 "));
    assert!(thinking.ends_with("<｜Assistant｜><think>"));

    let chat =
        parse_json(r#"{"messages":[{"role":"user","content":"hi"}],"enable_thinking":false}"#)
            .unwrap();
    let chat = render(&chat).unwrap();
    let chat = chat.as_str().unwrap();
    assert!(!chat.contains("Reasoning Effort:"));
    assert!(chat.ends_with("<｜Assistant｜></think>"));

    let bad =
        parse_json(r#"{"messages":[{"role":"user","content":"hi"}],"reasoning_effort":"medium"}"#)
            .unwrap();
    let error = render(&bad).unwrap_err();
    assert_eq!(
        error.message().as_str().unwrap(),
        "Invalid reasoning effort for deepseek_v41: medium, should be int within [1,100] or ['low', 'high', 'max']"
    );

    let options = EncodeOptions {
        thinking_mode: ThinkingMode::Chat,
        ..EncodeOptions::default()
    };
    let messages = parse_json(r#"[{"role":"critic","content":"no"}]"#).unwrap();
    let error = encode_messages(messages.as_array().unwrap(), &options).unwrap_err();
    assert_eq!(error.message().as_str().unwrap(), "Unknown role: critic");

    let conflict = parse_json(
        r#"{"messages":[{"role":"user","content":"hi"}],"thinking":{"type":"enabled"},"enable_thinking":false}"#,
    )
    .unwrap();
    let error = render(&conflict).unwrap_err();
    assert_eq!(
        error.message().as_str().unwrap(),
        "thinking, thinking_mode, and enable_thinking must select the same mode"
    );

    let image = parse_json(
        r#"{"messages":[{"role":"user","content":[{"type":"text","text":"see <｜deepseek_image｜>"}]}]}"#,
    )
    .unwrap();
    let error = render(&image).unwrap_err();
    assert!(
        error
            .message()
            .as_str()
            .unwrap()
            .contains("image placeholder")
    );
}

#[test]
fn tool_content_must_be_a_string() {
    let options = EncodeOptions {
        thinking_mode: ThinkingMode::Chat,
        ..EncodeOptions::default()
    };
    let object =
        parse_json(r#"[{"role":"tool","tool_call_id":"call_1","content":{"temperature":22}}]"#)
            .unwrap();
    let error = encode_messages(object.as_array().unwrap(), &options).unwrap_err();
    assert_eq!(
        error.message().as_str().unwrap(),
        "tool content must be a string"
    );

    let number = parse_json(r#"[{"role":"tool","tool_call_id":"call_1","content":22}]"#).unwrap();
    let error = encode_messages(number.as_array().unwrap(), &options).unwrap_err();
    assert_eq!(
        error.message().as_str().unwrap(),
        "tool content must be a string"
    );

    let empty = parse_json(r#"[{"role":"tool","tool_call_id":"call_1","content":null}]"#).unwrap();
    let prompt = encode_messages(empty.as_array().unwrap(), &options).unwrap();
    assert!(
        prompt
            .as_str()
            .unwrap()
            .contains("<tool_result></tool_result>")
    );

    let text = parse_json(
        r#"[{"role":"tool","tool_call_id":"call_1","content":"{\"temperature\": 22}"}]"#,
    )
    .unwrap();
    let prompt = encode_messages(text.as_array().unwrap(), &options).unwrap();
    assert!(
        prompt
            .as_str()
            .unwrap()
            .contains("<tool_result>{\"temperature\": 22}</tool_result>")
    );
}

#[test]
fn empty_user_prompt_is_170_bytes() {
    let body = parse_json(r#"{"messages":[{"role":"user","content":""}]}"#).unwrap();
    let prompt = render(&body).unwrap();
    assert_eq!(prompt.len(), 170);
}

#[test]
fn to_json_matches_python_dumps() {
    let sample = r#"{"a":1,"b":"中文","nested":{"ok":true,"n":null}}"#;
    let value = parse_json(sample).unwrap();
    let actual = encode::to_json(&value).unwrap();
    let output = Command::new("python3")
        .args([
            "-c",
            "import json,sys; print(json.dumps(json.load(sys.stdin), ensure_ascii=False))",
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            use std::io::Write;
            child.stdin.as_mut().unwrap().write_all(sample.as_bytes())?;
            drop(child.stdin.take());
            let output = child.wait_with_output()?;
            Ok(output)
        })
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected = String::from_utf8(output.stdout).unwrap();
    assert_eq!(actual.as_str().unwrap(), expected.trim_end());
}

#[test]
fn numbers_match_javascript() {
    let literals = [
        "0",
        "-0",
        "1",
        "-1",
        "1.5",
        "0.1",
        "0.3",
        "1e21",
        "1e20",
        "-1e20",
        "1e-6",
        "1e-7",
        "1.1",
        "22",
        "5e-324",
        "1.0000000000000002",
        "1e16",
        "9.99e20",
        "1234567.25",
        "-10.5",
        "1e+21",
        "9999999",
    ];
    let script = format!(
        "for (const n of [{}]) console.log(JSON.stringify(n));",
        literals.join(",")
    );
    let output = Command::new("node").args(["-e", &script]).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected: Vec<&str> = std::str::from_utf8(&output.stdout)
        .unwrap()
        .lines()
        .collect();
    assert_eq!(expected.len(), literals.len());
    for (literal, expected) in literals.iter().zip(expected) {
        let number: f64 = literal.parse().unwrap();
        assert_eq!(encode::format_number(number), expected, "{literal}");
    }
}
