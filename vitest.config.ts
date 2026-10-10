import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));
const bundleDir = join(root, "test/.bundle");

function bundleApiWorker(): string {
  execFileSync(join(root, "node_modules/wrangler/bin/wrangler.js"), ["deploy", "--dry-run", "--outdir", bundleDir], {
    cwd: root,
    stdio: "inherit",
  });
  return join(bundleDir, "index.js");
}

export default defineConfig({
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
            const scriptPath = bundleApiWorker();
            return {
              main: join(root, "test/worker-entry.ts"),
              miniflare: {
                compatibilityDate: "2026-10-09",
                serviceBindings: { API: "token-count" },
                workers: [
                  {
                    name: "token-count",
                    scriptPath,
                    modules: true,
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
