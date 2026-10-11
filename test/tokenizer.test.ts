import { expect, test } from "vitest";
import { TokenizerInputError } from "../src/tokenizer";

test("special tokens encode as single ids", async () => {
  const { encodeIds } = await import("../src/models/counter");
  expect(encodeIds("<｜begin▁of▁sentence｜>")).toEqual([0]);
  expect(encodeIds("<｜end▁of▁sentence｜>")).toEqual([1]);
  expect(encodeIds("<｜User｜>")).toEqual([128803]);
  expect(encodeIds("<｜Assistant｜>")).toEqual([128804]);
  expect(encodeIds("<｜System｜>")).toEqual([128799]);
  expect(encodeIds("<｜deepseek_image｜>")).toEqual([129264]);
}, 120_000);

test("unpaired surrogates are rejected", async () => {
  const { encodeIds } = await import("../src/models/counter");
  expect(() => encodeIds("\uD800")).toThrow(TokenizerInputError);
});
