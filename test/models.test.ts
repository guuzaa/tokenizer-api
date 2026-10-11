import { expect, test } from "vitest";
import { deepseekFlash } from "../src/models/deepseek-flash";
import { modelFamilies, resolveModel } from "../src/models/registry";
import type { Model } from "../src/models/types";

test("deepseek-flash is the V4.1 family", () => {
  expect(modelFamilies.map((family) => family.name)).toEqual(["deepseek-flash"]);
  expect(deepseekFlash.matches("deepseek-flash")).toBe(true);
  expect(deepseekFlash.matches("deepseek-flash-1")).toBe(false);
  expect(deepseekFlash.matches("deepseek-v4.1-flash")).toBe(true);
  expect(deepseekFlash.matches("deepseek-v4.1")).toBe(false);
  expect(deepseekFlash.matches("deepseek-v4")).toBe(false);
  expect(deepseekFlash.matches("deepseek-v4-flash")).toBe(false);
  expect(resolveModel("deepseek-flash", modelFamilies)?.name).toBe("deepseek-flash");
  expect(resolveModel("deepseek-v4.1-flash", modelFamilies)?.name).toBe("deepseek-flash");
  expect(resolveModel("deepseek-v4-flash", modelFamilies)).toBeUndefined();
});

test("the first matching family wins", () => {
  const exact: Model = {
    name: "deepseek-v4.1-flash",
    maxPromptBytes: 1024,
    matches: (model) => model === "deepseek-v4.1-flash",
    render: () => "",
    countTokens: () => 41,
  };
  const models = [exact, { ...deepseekFlash, countTokens: () => 4 }];
  expect(resolveModel("deepseek-v4.1-flash", models)?.name).toBe("deepseek-v4.1-flash");
  expect(resolveModel("deepseek-v4.1-pro", models)?.name).toBe("deepseek-flash");
  expect(resolveModel("missing", models)).toBeUndefined();
});
