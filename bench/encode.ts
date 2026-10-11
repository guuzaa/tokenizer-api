/**
 * Token timing is measured inside workerd, which is the runtime that serves the API.
 * `pnpm bench` builds the wasm module and runs bench/workerd.mjs under Node.
 */
import { spawnSync } from "node:child_process";

const result = spawnSync("node", [new URL("./workerd.mjs", import.meta.url).pathname], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
