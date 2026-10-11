import { expect, test } from "vitest";
import { deepseekFlash } from "../src/models/deepseek-flash";
import { deepseekV4 } from "../src/models/deepseek-v4";
import { modelFamilies, resolveModel } from "../src/models/registry";
import type { Model } from "../src/models/types";

test("deepseek-flash is the exact V4.1 id and deepseek-v4 stays last", () => {
  expect(modelFamilies[0]?.name).toBe("deepseek-flash");
  expect(modelFamilies[modelFamilies.length - 1]?.name).toBe("deepseek-v4");
  expect(deepseekFlash.matches("deepseek-flash")).toBe(true);
  expect(deepseekFlash.matches("deepseek-flash-1")).toBe(false);
  expect(deepseekFlash.matches("deepseek-v4.1-flash")).toBe(true);
  expect(deepseekV4.matches("deepseek-flash")).toBe(false);
  expect(resolveModel("deepseek-flash", modelFamilies)?.name).toBe("deepseek-flash");
  expect(resolveModel("deepseek-v4-flash", modelFamilies)?.name).toBe("deepseek-v4");
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
