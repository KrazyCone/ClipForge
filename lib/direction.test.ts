import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_DIRECTION_CHARS,
  captionDirectionSuffix,
  cleanDirection,
  withDirection,
} from "./direction.ts";

test("direction is appended to the analysis rules", () => {
  const prompt = withDirection("BASE RULES", "no emoji spam, always name the play");
  assert.match(prompt, /^BASE RULES/);
  assert.match(prompt, /no emoji spam/);
  assert.match(prompt, /never overrides the JSON shape/);
});

test("no direction leaves the prompt untouched", () => {
  assert.equal(withDirection("BASE RULES", undefined), "BASE RULES");
  assert.equal(withDirection("BASE RULES", "   \n "), "BASE RULES");
});

test("direction is capped and trimmed", () => {
  const clean = cleanDirection(`  ${"x".repeat(MAX_DIRECTION_CHARS + 50)}  `);
  assert.equal(clean.length, MAX_DIRECTION_CHARS);
  assert.equal(cleanDirection("  keep me  "), "keep me");
});

test("caption suffix carries the same direction, or nothing", () => {
  assert.match(captionDirectionSuffix("sound like a friend"), /sound like a friend/);
  assert.equal(captionDirectionSuffix(""), "");
});
