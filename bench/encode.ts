/**
 * Token timing is measured inside workerd, which is the runtime that serves the API.
 * Bun imports the wasm file as a path, and this counter is built for Workers and Vitest.
 */
import { spawnSync } from "node:child_process";

const result = spawnSync(process.execPath, [new URL("./workerd.mjs", import.meta.url).pathname], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
