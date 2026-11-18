import test from "node:test";
import assert from "node:assert/strict";
import { pollSignals } from "./poll.ts";

test("numeric poll answers are recognised", () => {
  const hint = pollSignals([...Array(12).fill("1"), "2", "1", "3"]);
  assert.equal(hint.likely, true);
  assert.equal(hint.top, "1");
  assert.ok(hint.share > 0.7);
});

test("yes/no voting without a clear majority is still a vote", () => {
  const hint = pollSignals([...Array(6).fill("yes"), ...Array(6).fill("no"), "!!!!"]);
  assert.equal(hint.likely, true);
  assert.equal(hint.distinct, 2);
});

test("command votes count as polls", () => {
  assert.equal(pollSignals(Array(10).fill("!vote")).likely, true);
});

test("reaction spam is not treated as a poll", () => {
  assert.equal(pollSignals(Array(14).fill("KEKW")).likely, false);
  assert.equal(pollSignals(Array(14).fill("W")).likely, false);
  assert.equal(pollSignals(Array(14).fill("LMAO NO WAY")).likely, false);
});

test("ordinary varied chat is not a poll", () => {
  const messages = [
    "that was insane", "no way he hit that", "bro is cracked", "GG", "what a play",
    "how did he survive", "clip it", "that shot was crazy", "lmao", "unreal",
  ];
  assert.equal(pollSignals(messages).likely, false);
});

test("too few samples never flags a poll", () => {
  assert.equal(pollSignals(["1", "1", "1"]).likely, false);
});
