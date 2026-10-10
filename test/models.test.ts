import { expect, test } from "vitest";
import { deepseekV4 } from "../src/models/deepseek-v4";
import { modelFamilies, resolveModel } from "../src/models/registry";
import type { Model } from "../src/models/types";

test("deepseek-v4 is the last family so a more specific one can be registered above it", () => {
  expect(modelFamilies[modelFamilies.length - 1]?.name).toBe("deepseek-v4");
});

test("deepseek-v4 matches its prefix and leaves a dotted v4.1 id unmatched", () => {
  expect(deepseekV4.matches("deepseek-v4")).toBe(true);
  expect(deepseekV4.matches("deepseek-v4-flash")).toBe(true);
  expect(deepseekV4.matches("deepseek-v4.1-flash")).toBe(false);
});

test("the first matching family wins", () => {
  const v41: Model = {
    name: "deepseek-v4.1-flash",
    maxPromptBytes: 1024,
    matches: (model) => model === "deepseek-v4.1-flash",
    render: () => "",
    countTokens: () => 41,
  };
  const models = [v41, { ...deepseekV4, countTokens: () => 4 }];
  expect(resolveModel("deepseek-v4.1-flash", models)?.name).toBe("deepseek-v4.1-flash");
  expect(resolveModel("deepseek-v4-flash", models)?.name).toBe("deepseek-v4");
  expect(resolveModel("missing", models)).toBeUndefined();
});
