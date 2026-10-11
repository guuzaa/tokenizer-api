/**
 * Replay fixtures/golden.json against a workerd bundle.
 *
 *   node scripts/golden.mjs record <bundle-dir> <fixtures-out>
 *   node scripts/golden.mjs check <bundle-dir> <fixtures>
 *
 * The bundle directory is a `wrangler deploy --dry-run --outdir` result:
 * shim.js or index.js, plus the compiled wasm module.
 */
import http from "node:http";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(new URL("../package.json", import.meta.url));
const { Miniflare } = require("miniflare");

const mode = process.argv[2];
const bundleDir = process.argv[3] ? resolve(process.argv[3]) : "";
const fixturePath = process.argv[4];
if (!mode || !bundleDir || !fixturePath || (mode !== "record" && mode !== "check")) {
  console.error("usage: node scripts/golden.mjs <record|check> <bundle-dir> <fixtures.json>");
  process.exit(2);
}

function bundleModules() {
  const jsName = ["index.js", "shim.js"].find((name) => existsSync(`${bundleDir}/${name}`));
  const wasmName = readdirSync(bundleDir).find((name) => name.endsWith(".wasm"));
  if (!jsName || !wasmName) throw new Error(`bundle in ${bundleDir} needs a js entry and a wasm module`);
  return {
    main: jsName,
    modules: {
      [jsName]: { type: "esm", contents: readFileSync(`${bundleDir}/${jsName}`, "utf8") },
      [wasmName]: { type: "wasm", contents: readFileSync(`${bundleDir}/${wasmName}`) },
    },
  };
}

function textBindings(bindings) {
  const env = {
    RATE_LIMITER: {
      type: "rate-limit",
      namespace: "1001",
      simple: { limit: 60, period: 60 },
    },
  };
  for (const [name, value] of Object.entries(bindings ?? {})) {
    env[name] = { type: "text", value: String(value) };
  }
  return env;
}

async function start(bindings) {
  const bundle = bundleModules();
  return new Miniflare({
    workers: [
      {
        config: {
          name: "token-count",
          compatibilityDate: "2026-10-09",
          manifest: {
            mainModule: bundle.main,
            modulesRoot: bundleDir,
            modules: bundle.modules,
          },
          env: textBindings(bindings),
        },
      },
    ],
  });
}

function expand(cases) {
  const out = [];
  for (const entry of cases) {
    const times = entry.repeat ?? 1;
    for (let i = 0; i < times; i++) {
      out.push({ ...entry, name: times > 1 ? `${entry.name} #${i + 1}` : entry.name, repeat: undefined });
    }
  }
  return out;
}

function requestBody(request) {
  if (request.bodyBase64 != null) return Buffer.from(request.bodyBase64, "base64");
  if (request.body == null) return undefined;
  return request.body;
}

async function dispatch(mf, request) {
  const url = await mf.ready;
  const body = requestBody(request);
  const method = request.method ?? "GET";
  const headers = { ...(request.headers ?? {}) };
  const sendsBody = body != null && method !== "GET" && method !== "HEAD";
  if (sendsBody && headers["content-length"] == null && headers["Content-Length"] == null) {
    headers["content-length"] = Buffer.byteLength(body);
  }
  const response = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: request.path ?? "/",
        method,
        headers: { connection: "close", ...headers },
        timeout: 8_000,
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ statusCode: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks) }));
      },
    );
    req.on("timeout", () => req.destroy(new Error(`timeout ${method} ${request.path}`)));
    req.on("error", reject);
    if (sendsBody) req.end(body);
    else req.end();
  });
  const interesting = {};
  for (const name of ["content-type", "retry-after"]) {
    const value = response.headers[name];
    if (value != null) interesting[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return { status: response.statusCode, headers: interesting, body: response.raw.toString("utf8") };
}

function sameResponse(actual, expected) {
  if (actual.status !== expected.status) return false;
  const keys = new Set([...Object.keys(actual.headers), ...Object.keys(expected.headers ?? {})]);
  for (const key of keys) {
    if ((actual.headers[key] ?? null) !== (expected.headers?.[key] ?? null)) return false;
  }
  return actual.body === expected.body;
}

const corpus = mode === "record" ? buildCorpus() : null;
const document = mode === "record" ? { suites: corpus } : JSON.parse(readFileSync(fixturePath, "utf8"));

let failed = 0;
let checked = 0;
for (const suite of document.suites) {
  const mf = await start(suite.bindings);
  try {
    const cases = mode === "record" ? suite.cases : expand(suite.cases);
    for (const entry of cases) {
      const actual = await dispatch(mf, entry.request);
      checked++;
      if (mode === "record") {
        entry.response = actual;
      } else if (!sameResponse(actual, entry.response)) {
        failed++;
        console.error(`FAIL ${suite.name} / ${entry.name}`);
        console.error("  expected", JSON.stringify(entry.response));
        console.error("  actual  ", JSON.stringify(actual));
      }
    }
    if (mode === "record") suite.cases = collapseRepeats(suite.cases);
  } finally {
    await mf.dispose();
  }
}

if (mode === "record") {
  writeFileSync(fixturePath, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`recorded ${checked} responses to ${fixturePath}`);
} else if (failed) {
  console.error(`${failed} of ${checked} golden cases failed`);
  process.exit(1);
} else {
  console.log(`${checked} golden cases passed`);
}

function collapseRepeats(cases) {
  const out = [];
  for (const entry of cases) {
    const previous = out[out.length - 1];
    const same =
      previous &&
      JSON.stringify(previous.request) === JSON.stringify(entry.request) &&
      JSON.stringify(previous.response) === JSON.stringify(entry.response);
    if (same) previous.repeat = (previous.repeat ?? 1) + 1;
    else out.push(entry);
  }
  return out;
}

function buildCorpus() {
  const hello = { model: "deepseek-flash", messages: [{ role: "user", content: "hi" }] };
  let ip = 1;
  const nextIp = () => `203.0.113.${ip++}`;
  const post = (body, extra = {}) => ({
    method: "POST",
    path: extra.path ?? "/v1/token/count",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": extra.ip ?? nextIp(),
      ...extra.headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

  const readme = {
    model: "deepseek-flash",
    thinking_mode: "chat",
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello" },
    ],
  };

  const tools = [
    {
      type: "function",
      function: {
        name: "Calculator",
        description: "算术",
        parameters: { type: "object", properties: { formula: { type: "string" } } },
      },
    },
  ];

  const atCapContent = "7".repeat(8192 - 170);
  const core = JSON.stringify({ model: "deepseek-flash", messages: [{ role: "user", content: "hi" }] });
  const coreBytes = Buffer.byteLength(core);
  const atBodyCap = core + " ".repeat(49152 - coreBytes);
  const overBody = `${atBodyCap} `;

  const fixture = (name) => {
    const raw = JSON.parse(readFileSync(new URL(`../test/test_data/deepseek-v4.1/${name}`, import.meta.url), "utf8"));
    if (Array.isArray(raw)) return { model: "deepseek-flash", thinking_mode: "chat", messages: raw };
    return { model: "deepseek-flash", ...raw };
  };

  const publicCases = [
    { name: "readme chat", request: post(readme) },
    { name: "default thinking", request: post({ model: "deepseek-flash", messages: readme.messages }) },
    { name: "deepseek-v4.1-flash", request: post({ ...readme, model: "deepseek-v4.1-flash" }) },
    { name: "deepseek-v4.1-pro prefix", request: post({ ...hello, model: "deepseek-v4.1-pro" }) },
    { name: "deepseek-v4.1- bare prefix", request: post({ ...hello, model: "deepseek-v4.1-" }) },
    { name: "reject deepseek-v4.1", request: post({ ...hello, model: "deepseek-v4.1" }) },
    { name: "reject deepseek-v4", request: post({ ...hello, model: "deepseek-v4" }) },
    { name: "reject deepseek-v4-flash", request: post({ ...hello, model: "deepseek-v4-flash" }) },
    { name: "reject deepseek-flash-1", request: post({ ...hello, model: "deepseek-flash-1" }) },
    { name: "reject gpt-4o", request: post({ ...hello, model: "gpt-4o" }) },
    { name: "reject step-5-preview", request: post({ ...hello, model: "step-5-preview" }) },
    { name: "reject empty model", request: post({ ...hello, model: "" }) },
    { name: "reject missing model", request: post({ messages: [{ role: "user", content: "hi" }] }) },
    { name: "reject numeric model", request: post({ model: 1, messages: [{ role: "user", content: "hi" }] }) },
    { name: "system user assistant", request: post({
      model: "deepseek-flash",
      thinking_mode: "chat",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
        { role: "user", content: "Thanks" },
      ],
    }) },
    { name: "latest_reminder", request: post({
      model: "deepseek-flash",
      thinking_mode: "chat",
      messages: [
        { role: "system", content: "sys" },
        { role: "latest_reminder", content: "2024-11-15,上海市" },
        { role: "user", content: "hi" },
      ],
    }) },
    { name: "unknown role", request: post({ model: "deepseek-flash", messages: [{ role: "critic", content: "no" }] }) },
    { name: "developer role", request: post({ model: "deepseek-flash", messages: [{ role: "developer", content: "no" }] }) },
    { name: "empty messages", request: post({ model: "deepseek-flash", messages: [] }) },
    { name: "missing messages", request: post({ model: "deepseek-flash" }) },
    { name: "message not object", request: post({ model: "deepseek-flash", messages: ["hi"] }) },
    { name: "null message", request: post({ model: "deepseek-flash", messages: [null] }) },
    { name: "thinking enabled", request: post({ model: "deepseek-flash", thinking: { type: "enabled" }, messages: [{ role: "user", content: "你好" }] }) },
    { name: "thinking disabled", request: post({ model: "deepseek-flash", thinking: { type: "disabled" }, messages: [{ role: "user", content: "你好" }] }) },
    { name: "thinking_mode chat", request: post({ model: "deepseek-flash", thinking_mode: "chat", messages: [{ role: "user", content: "你好" }] }) },
    { name: "thinking_mode thinking", request: post({ model: "deepseek-flash", thinking_mode: "thinking", messages: [{ role: "user", content: "你好" }] }) },
    { name: "enable_thinking true", request: post({ model: "deepseek-flash", enable_thinking: true, messages: [{ role: "user", content: "hi" }] }) },
    { name: "enable_thinking false", request: post({ model: "deepseek-flash", enable_thinking: false, messages: [{ role: "user", content: "hi" }] }) },
    { name: "thinking switches agree", request: post({
      model: "deepseek-flash",
      thinking: { type: "disabled" },
      thinking_mode: "chat",
      enable_thinking: false,
      messages: [{ role: "user", content: "hi" }],
    }) },
    { name: "thinking switches conflict", request: post({
      model: "deepseek-flash",
      thinking: { type: "enabled" },
      thinking_mode: "chat",
      messages: [{ role: "user", content: "hi" }],
    }) },
    { name: "invalid thinking_mode", request: post({ model: "deepseek-flash", thinking_mode: "fast", messages: [{ role: "user", content: "hi" }] }) },
    { name: "enable_thinking not boolean", request: post({ model: "deepseek-flash", enable_thinking: "yes", messages: [{ role: "user", content: "hi" }] }) },
    { name: "thinking wrong shape", request: post({ model: "deepseek-flash", thinking: "enabled", messages: [{ role: "user", content: "hi" }] }) },
    { name: "thinking.type invalid", request: post({ model: "deepseek-flash", thinking: { type: "maybe" }, messages: [{ role: "user", content: "hi" }] }) },
    { name: "effort low", request: post({ model: "deepseek-flash", reasoning_effort: "low", messages: [{ role: "user", content: "hi" }] }) },
    { name: "effort high", request: post({ model: "deepseek-flash", reasoning_effort: "high", messages: [{ role: "user", content: "hi" }] }) },
    { name: "effort max", request: post({ model: "deepseek-flash", reasoning_effort: "max", messages: [{ role: "user", content: "hi" }] }) },
    { name: "effort 1", request: post({ model: "deepseek-flash", reasoning_effort: 1, messages: [{ role: "user", content: "hi" }] }) },
    { name: "effort 40", request: post({ model: "deepseek-flash", reasoning_effort: 40, messages: [{ role: "user", content: "hi" }] }) },
    { name: "effort 100", request: post({ model: "deepseek-flash", reasoning_effort: 100, messages: [{ role: "user", content: "hi" }] }) },
    { name: "effort 0", request: post({ model: "deepseek-flash", reasoning_effort: 0, messages: [{ role: "user", content: "hi" }] }) },
    { name: "effort 101", request: post({ model: "deepseek-flash", reasoning_effort: 101, messages: [{ role: "user", content: "hi" }] }) },
    { name: "effort 1.5", request: post({ model: "deepseek-flash", reasoning_effort: 1.5, messages: [{ role: "user", content: "hi" }] }) },
    { name: "effort minimal", request: post({ model: "deepseek-flash", reasoning_effort: "minimal", messages: [{ role: "user", content: "hi" }] }) },
    { name: "effort null", request: post({ model: "deepseek-flash", reasoning_effort: null, messages: [{ role: "user", content: "hi" }] }) },
    { name: "effort boolean", request: post({ model: "deepseek-flash", reasoning_effort: true, messages: [{ role: "user", content: "hi" }] }) },
    { name: "effort object", request: post({ model: "deepseek-flash", reasoning_effort: { level: "high" }, messages: [{ role: "user", content: "hi" }] }) },
    { name: "effort array", request: post({ model: "deepseek-flash", reasoning_effort: ["high"], messages: [{ role: "user", content: "hi" }] }) },
    { name: "effort invalid in chat mode", request: post({ model: "deepseek-flash", thinking_mode: "chat", reasoning_effort: "xhigh", messages: [{ role: "user", content: "hi" }] }) },
    { name: "tools on system message", request: post({
      model: "deepseek-flash",
      thinking: { type: "enabled" },
      messages: [
        { role: "system", content: "你是助手" },
        { role: "user", content: "算一下" },
      ],
      tools,
    }) },
    { name: "tools without system message", request: post({
      model: "deepseek-flash",
      thinking_mode: "chat",
      messages: [{ role: "user", content: "算一下" }],
      tools: [{ type: "function", function: { name: "Calculator", parameters: { type: "object" } } }],
    }) },
    { name: "tools already on system are kept", request: post({
      model: "deepseek-flash",
      thinking_mode: "chat",
      messages: [{ role: "system", content: "sys", tools: [{ type: "function", function: { name: "Kept", parameters: { type: "object" } } }] }, { role: "user", content: "hi" }],
      tools,
    }) },
    { name: "empty tools list", request: post({ model: "deepseek-flash", thinking_mode: "chat", messages: [{ role: "user", content: "hi" }], tools: [] }) },
    { name: "tools not a list", request: post({ model: "deepseek-flash", messages: [{ role: "user", content: "hi" }], tools: { type: "function" } }) },
    { name: "tool call string arguments and tool result", request: post({
      model: "deepseek-flash",
      thinking_mode: "chat",
      messages: [
        { role: "user", content: "北京天气怎么样？" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: JSON.stringify({ city: "北京" }) } }],
        },
        { role: "tool", tool_call_id: "c1", content: "晴，26度" },
        { role: "user", content: "谢谢" },
      ],
    }) },
    { name: "tool call object arguments", request: post({
      model: "deepseek-flash",
      thinking_mode: "chat",
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c1", type: "function", function: { name: "ns::lookup", arguments: { q: "a", n: 2, ok: true } } }],
        },
        { role: "tool", tool_call_id: "c1", content: "done" },
      ],
    }) },
    { name: "tool content object rejected", request: post({
      model: "deepseek-flash",
      messages: [
        { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{\"location\":\"Beijing\"}" } }] },
        { role: "tool", tool_call_id: "call_1", content: { temperature: 22 } },
      ],
    }) },
    { name: "tool content number rejected", request: post({
      model: "deepseek-flash",
      messages: [{ role: "tool", tool_call_id: "call_1", content: 22 }],
    }) },
    { name: "tool content null", request: post({
      model: "deepseek-flash",
      thinking_mode: "chat",
      messages: [{ role: "tool", tool_call_id: "call_1", content: null }],
    }) },
    { name: "tool content string json", request: post({
      model: "deepseek-flash",
      thinking_mode: "chat",
      messages: [{ role: "tool", tool_call_id: "call_1", content: "{\"temperature\": 22}" }],
    }) },
    { name: "image_url block", request: post({
      model: "deepseek-flash",
      thinking_mode: "chat",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }],
    }) },
    { name: "image block", request: post({
      model: "deepseek-flash",
      thinking_mode: "chat",
      messages: [{ role: "user", content: [{ type: "text", text: "see" }, { type: "image", source: { url: "https://example.com/a.png" } }] }],
    }) },
    { name: "image placeholder in text rejected", request: post({
      model: "deepseek-flash",
      messages: [{ role: "user", content: [{ type: "text", text: "see <｜deepseek_image｜>" }] }],
    }) },
    { name: "reasoning dropped by default", request: post({
      model: "deepseek-flash",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi", reasoning_content: "The user said hello." },
        { role: "user", content: "Again" },
      ],
    }) },
    { name: "reasoning kept", request: post({
      model: "deepseek-flash",
      drop_thinking: false,
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi", reasoning_content: "The user said hello." },
        { role: "user", content: "Again" },
      ],
    }) },
    { name: "drop_thinking not boolean", request: post({ model: "deepseek-flash", drop_thinking: "yes", messages: [{ role: "user", content: "hi" }] }) },
    { name: "add_default_bos_token false is ignored", request: post({
      model: "deepseek-flash",
      thinking_mode: "chat",
      add_default_bos_token: false,
      messages: [{ role: "user", content: "Hello" }],
    }) },
    { name: "chat hello without the ignored field", request: post({
      model: "deepseek-flash",
      thinking_mode: "chat",
      messages: [{ role: "user", content: "Hello" }],
    }) },
    { name: "empty content", request: post({ model: "deepseek-flash", messages: [{ role: "user", content: "" }] }) },
    { name: "missing content", request: post({ model: "deepseek-flash", thinking_mode: "chat", messages: [{ role: "user" }] }) },
    { name: "null content", request: post({ model: "deepseek-flash", thinking_mode: "chat", messages: [{ role: "user", content: null }] }) },
    { name: "numeric content", request: post({ model: "deepseek-flash", thinking_mode: "chat", messages: [{ role: "user", content: 22 }] }) },
    { name: "unicode", request: post({ model: "deepseek-flash", thinking_mode: "chat", messages: [{ role: "user", content: "你好，深度求索" }] }) },
    { name: "emoji", request: post({ model: "deepseek-flash", thinking_mode: "chat", messages: [{ role: "user", content: "👋" }] }) },
    { name: "lone surrogate", request: post({ model: "deepseek-flash", messages: [{ role: "user", content: "\uD800" }] }) },
    { name: "lone surrogate in the middle", request: post({ model: "deepseek-flash", thinking_mode: "chat", messages: [{ role: "user", content: "a\uD800b" }] }) },
    { name: "invalid utf-8 becomes replacement", request: {
      method: "POST",
      path: "/v1/token/count",
      headers: { "content-type": "application/json", "cf-connecting-ip": nextIp() },
      bodyBase64: Buffer.from(`{"model":"deepseek-flash","thinking_mode":"chat","messages":[{"role":"user","content":"a\xffb"}]}`, "latin1").toString("base64"),
    } },
    { name: "invalid json", request: post("not-json") },
    { name: "empty body", request: post("") },
    { name: "json null", request: post("null") },
    { name: "json array", request: post("[]") },
    { name: "json number", request: post("1") },
    { name: "trailing comma", request: post('{"model":"deepseek-flash",}') },
    { name: "get method", request: { method: "GET", path: "/v1/token/count", headers: { "cf-connecting-ip": nextIp() } } },
    { name: "put method", request: { method: "PUT", path: "/v1/token/count", headers: { "cf-connecting-ip": nextIp() } } },
    { name: "delete method", request: { method: "DELETE", path: "/v1/token/count", headers: { "cf-connecting-ip": nextIp() } } },
    { name: "patch method", request: { method: "PATCH", path: "/v1/token/count", headers: { "cf-connecting-ip": nextIp() } } },
    { name: "health path", request: { method: "POST", path: "/health", headers: { "content-type": "application/json", "cf-connecting-ip": nextIp() }, body: "{}" } },
    { name: "root path", request: { method: "GET", path: "/", headers: { "cf-connecting-ip": nextIp() } } },
    { name: "trailing slash", request: post(hello, { path: "/v1/token/count/" }) },
    { name: "query string is not part of the path", request: post(readme, { path: "/v1/token/count?x=1" }) },
    { name: "body over the cap", request: post({ model: "deepseek-flash", messages: [{ role: "user", content: "x".repeat(49152) }] }) },
    { name: "non-json over the cap", request: post(`not-json${"x".repeat(49152)}`) },
    { name: "body at the cap", request: post(atBodyCap) },
    { name: "body one byte over the cap", request: post(overBody) },
    { name: "content-length over the cap with a short body", request: post(hello, { headers: { "content-length": "49153" } }) },
    { name: "prompt over the cap", request: post({ model: "deepseek-flash", messages: [{ role: "user", content: "a".repeat(8192) }] }) },
    { name: "prompt at the cap", request: post({ model: "deepseek-flash", messages: [{ role: "user", content: atCapContent }] }) },
    { name: "prompt one byte over the cap", request: post({ model: "deepseek-flash", messages: [{ role: "user", content: `${atCapContent}7` }] }) },
    { name: "official input 1", request: post(fixture("test_input_1.json")) },
    { name: "official input 2", request: post(fixture("test_input_2.json")) },
    { name: "official input 3", request: post(fixture("test_input_3.json")) },
    { name: "official input 4", request: post(fixture("test_input_4.json")) },
    { name: "official input 5", request: post(fixture("test_input_5.json")) },
    { name: "response_format and wo_eos", request: post({
      model: "deepseek-flash",
      thinking_mode: "chat",
      messages: [{
        role: "system",
        content: "reply",
        response_format: { type: "json_object" },
      }, {
        role: "user",
        content: "ok",
      }, {
        role: "assistant",
        content: "yes",
        wo_eos: true,
      }],
    }) },
  ];

  const limitedIp = "198.51.100.60";
  const rateCases = [];
  for (let i = 0; i < 60; i++) {
    rateCases.push({ name: "under the rate limit", request: post(hello, { ip: limitedIp }) });
  }
  rateCases.push({ name: "rate limit exceeded", request: post(hello, { ip: limitedIp }) });
  rateCases.push({ name: "other ip is a separate bucket", request: post(hello, { ip: "198.51.100.61" }) });
  rateCases.push({ name: "missing ip shares unknown", request: post(hello, { headers: { "cf-connecting-ip": "" } }) });

  const authedIp = "198.51.100.80";
  const apiCases = [
    { name: "missing token", request: post(hello, { ip: "198.51.100.70" }) },
    { name: "unknown token", request: post(hello, { ip: "198.51.100.71", headers: { authorization: "Bearer nope" } }) },
    { name: "malformed authorization", request: post(hello, { ip: "198.51.100.72", headers: { authorization: "Token one" } }) },
    { name: "valid token two", request: post(hello, { ip: "198.51.100.73", headers: { authorization: "Bearer two" } }) },
    { name: "valid token one lowercase bearer", request: post(hello, { ip: "198.51.100.74", headers: { authorization: "bearer one" } }) },
    { name: "whitespace around the token", request: post(hello, { ip: "198.51.100.75", headers: { authorization: "Bearer   two  " } }) },
  ];
  for (let i = 0; i < 60; i++) {
    apiCases.push({
      name: "key bucket under the limit",
      request: post(hello, { ip: `198.51.100.${100 + (i % 50)}`, headers: { authorization: "Bearer one" } }),
    });
  }
  apiCases.push({
    name: "key bucket exceeded",
    request: post(hello, { ip: "198.51.100.90", headers: { authorization: "Bearer one" } }),
  });
  for (let i = 0; i < 60; i++) {
    apiCases.push({
      name: "unauthenticated requests share the ip bucket",
      request: post(hello, { ip: authedIp, headers: { authorization: "Bearer nope" } }),
    });
  }
  apiCases.push({
    name: "invalid key is 429 once the ip bucket is exhausted",
    request: post(hello, { ip: authedIp, headers: { authorization: "Bearer nope" } }),
  });

  const overrideCases = [
    { name: "tiny body cap", request: post(hello) },
    { name: "raised prompt cap allows 8 KiB of a", request: post({ model: "deepseek-flash", messages: [{ role: "user", content: "c".repeat(8192) }] }) },
    { name: "invalid prompt var keeps the default", request: post({ model: "deepseek-flash", messages: [{ role: "user", content: "c".repeat(8192) }] }) },
  ];

  return [
    { name: "public", bindings: { MAX_PROMPT_BYTES: "8192", MAX_BODY_BYTES: "49152" }, cases: publicCases.concat(rateCases) },
    { name: "api-keys", bindings: { API_KEYS: "one, two", MAX_PROMPT_BYTES: "8192", MAX_BODY_BYTES: "49152" }, cases: apiCases },
    { name: "body-cap-32", bindings: { MAX_BODY_BYTES: "32", MAX_PROMPT_BYTES: "8192" }, cases: [overrideCases[0]] },
    { name: "prompt-cap-16384", bindings: { MAX_PROMPT_BYTES: "16384", MAX_BODY_BYTES: "49152" }, cases: [overrideCases[1]] },
    { name: "invalid-prompt-var", bindings: { MAX_PROMPT_BYTES: "nope", MAX_BODY_BYTES: "49152" }, cases: [overrideCases[2]] },
  ];
}
