import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { unstable_dev } from "wrangler";

const bundleDir = new URL("../test/.bench-bundle/", import.meta.url);
const wranglerBin = new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url);
const configPath = new URL("./wrangler.toml", import.meta.url).pathname;
const scriptPath = new URL("./worker.ts", import.meta.url).pathname;

rmSync(bundleDir, { recursive: true, force: true });
const dry = spawnSync(
  process.execPath,
  [wranglerBin.pathname, "deploy", "--dry-run", "--outdir", bundleDir.pathname, "--config", configPath],
  { cwd: new URL("./", import.meta.url).pathname, stdio: "inherit" },
);
if (dry.status !== 0) process.exit(dry.status ?? 1);

const bundleFiles = readdirSync(bundleDir).filter((name) => name.endsWith(".js") || name.endsWith(".wasm"));
const bundleBytes = bundleFiles.reduce((sum, name) => sum + statSync(new URL(name, bundleDir)).size, 0);
const bundleGzipBytes = bundleFiles.reduce((sum, name) => sum + gzipSync(readFileSync(new URL(name, bundleDir))).byteLength, 0);

function workerdRss() {
  const ps = spawnSync("ps", ["-eo", "pid,rss,comm,args"], { encoding: "utf8" });
  const rows = ps.stdout
    .split("\n")
    .filter((line) => line.includes("workerd"))
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      return { pid: Number(parts[0]), rssKb: Number(parts[1]) };
    });
  const rssKb = rows.reduce((sum, row) => sum + (Number.isFinite(row.rssKb) ? row.rssKb : 0), 0);
  return { processes: rows.length, rssMb: rssKb / 1024 };
}

const worker = await unstable_dev(scriptPath, {
  config: configPath,
  local: true,
  logLevel: "error",
  experimental: { disableExperimentalWarning: true, forceLocal: true, disableDevRegistry: true, watch: false },
});

async function sample(preset) {
  const started = performance.now();
  const response = await worker.fetch(`http://example.com/?preset=${preset}`);
  const wallMs = performance.now() - started;
  const body = await response.json();
  return { status: response.status, wallMs, ...body };
}

const cold = await sample("small");
const warm = [];
for (const preset of ["small", "mid", "cap"]) {
  const runs = [];
  for (let i = 0; i < 5; i++) runs.push(await sample(preset));
  const encode = runs.map((run) => run.encodeMs).sort((a, b) => a - b);
  const wall = runs.map((run) => run.wallMs).sort((a, b) => a - b);
  warm.push({
    preset,
    bytes: runs[0].bytes,
    tokens: runs[0].tokens,
    encodeMsMedian: encode[2],
    encodeMsMin: encode[0],
    wallMsMedian: wall[2],
  });
}

const report = {
  bundleBytes,
  bundleGzipBytes,
  cold,
  warm,
  memory: workerdRss(),
};
console.log(JSON.stringify(report, null, 2));
await worker.stop();
