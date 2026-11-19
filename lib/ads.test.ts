import test from "node:test";
import assert from "node:assert/strict";
import { chatAdShare, chatLooksLikeAd, looksLikeAdFrame } from "./ads.ts";

test("a described ad page counts as an ad", () => {
  assert.equal(looksLikeAdFrame("An advertisement for a mobile game is playing."), true);
  assert.equal(looksLikeAdFrame("A purple screen reads: the stream will continue shortly."), true);
  assert.equal(looksLikeAdFrame("A 'be right back' screen with no gameplay."), true);
});

test("real gameplay is not an ad", () => {
  assert.equal(looksLikeAdFrame("A player dies in a firefight in Grand Theft Auto."), false);
  assert.equal(looksLikeAdFrame("The streamer is laughing with a face cam in the corner."), false);
  assert.equal(looksLikeAdFrame(""), false);
});

test("chat shouting about ads is an ad break", () => {
  const messages = ["a: ad", "b: ads", "c: adblock", "d: ad", "e: AD", "f: nice shot"];
  assert.equal(chatLooksLikeAd(messages), true);
  assert.ok(chatAdShare(messages) > 0.7);
});

test("ordinary chat is not an ad break", () => {
  const messages = ["a: that was crazy", "b: W", "c: no way", "d: ad?", "e: gg"];
  assert.equal(chatLooksLikeAd(messages), false);
});

test("too few messages give no verdict", () => {
  assert.equal(chatAdShare(["a: ad", "b: ad"]), 0);
  assert.equal(chatLooksLikeAd(["a: ad"]), false);
});
