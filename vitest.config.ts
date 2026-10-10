import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig, type Plugin } from "vitest/config";

/** Node tests import the wasm module directly. Wrangler compiles it for the worker bundle. */
function wasmModulePlugin(): Plugin {
  return {
    name: "wasm-module",
    enforce: "pre",
    load(id) {
      if (!id.endsWith(".wasm")) return null;
      const bytes = readFileSync(id);
      return `const bytes = Uint8Array.from(atob(${JSON.stringify(bytes.toString("base64"))}), (char) => char.charCodeAt(0));
export default new WebAssembly.Module(bytes);`;
    },
  };
}

const root = dirname(fileURLToPath(import.meta.url));
const bundleDir = join(root, "test/.bundle");

function bundleApiWorker(): { scriptPath: string; wasmPath: string } {
  rmSync(bundleDir, { recursive: true, force: true });
  execFileSync(join(root, "node_modules/wrangler/bin/wrangler.js"), ["deploy", "--dry-run", "--outdir", bundleDir], {
    cwd: root,
    stdio: "inherit",
  });
  const wasmName = readdirSync(bundleDir).find((name) => name.endsWith(".wasm"));
  if (wasmName == null) throw new Error("wrangler bundle is missing the tokenizer wasm module");
  return { scriptPath: join(bundleDir, "index.js"), wasmPath: join(bundleDir, wasmName) };
}

export default defineConfig({
  plugins: [wasmModulePlugin()],
  test: {
    testTimeout: 120_000,
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["test/**/*.test.ts"],
          exclude: ["test/**/*.worker.test.ts"],
        },
      },
      {
        plugins: [
          cloudflareTest(async () => {
            const { scriptPath, wasmPath } = bundleApiWorker();
            return {
              main: join(root, "test/worker-entry.ts"),
              miniflare: {
                compatibilityDate: "2026-10-09",
                serviceBindings: { API: "token-count" },
                workers: [
                  {
                    name: "token-count",
                    modules: [
                      { type: "ESModule", path: scriptPath },
                      { type: "CompiledWasm", path: wasmPath },
                    ],
                    modulesRoot: bundleDir,
                    compatibilityDate: "2026-10-09",
                    ratelimits: {
                      RATE_LIMITER: {
                        namespace_id: "1001",
                        simple: { limit: 60, period: 60 },
                      },
                    },
                  },
                ],
              },
            };
          }),
        ],
        test: {
          name: "workers",
          include: ["test/**/*.worker.test.ts"],
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
