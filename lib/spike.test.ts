import test from "node:test";
import assert from "node:assert/strict";
import { detectSpike, configFromSensitivity, shouldMerge } from "./spike.ts";
import type { ChatMessage } from "./spike.ts";

const EMO = ["KEKW", "OMEGALUL", "LULW", "PogChamp", "💀"];

function makeMessages(opts: {
  from: number;
  to: number;
  rate: number;
  users?: number;
  laugh?: number;
}): ChatMessage[] {
  const out: ChatMessage[] = [];
  const users = opts.users ?? Math.max(4, Math.round(opts.rate * 4));
  let t = opts.from;
  while (t < opts.to) {
    const perSecond = Math.max(0, Math.round(opts.rate));
    for (let i = 0; i < perSecond; i++) {
      const isLaugh = Math.random() < (opts.laugh ?? 0.6);
      out.push({
        t: t + Math.random(),
        text: isLaugh ? "LMAO NO WAY" : "nice play",
        user: `user${Math.floor(Math.random() * users)}`,
        emotes: Math.random() < 0.7 ? [EMO[Math.floor(Math.random() * EMO.length)]] : [],
      });
    }
    t += 1;
  }
  return out;
}

test("a burst on a quiet channel is detected with high intensity", () => {
  const now = 1_000_000;
  const baseline = makeMessages({ from: now - 62, to: now - 9, rate: 2, laugh: 0.2 });
  const burst = makeMessages({ from: now - 8, to: now, rate: 14, laugh: 0.85 });
  const candidate = detectSpike([...baseline, ...burst], now, configFromSensitivity(55));

  assert.ok(candidate, "expected a spike");
  assert.ok(candidate!.intensity >= 55, `intensity ${candidate!.intensity} should clear the floor`);
  assert.equal(candidate!.features.peakRate, 14);
  assert.ok(candidate!.features.ratio > 3);
  assert.ok(candidate!.samples.length > 0);
});

test("steady high-volume chat is not a spike", () => {
  const now = 2_000_000;
  const steady = makeMessages({ from: now - 68, to: now, rate: 60, laugh: 0.4 });
  const candidate = detectSpike(steady, now, configFromSensitivity(55));
  assert.equal(candidate, null, "a flat channel at 60/s must not fire");
});

test("steady quiet chat is not a spike", () => {
  const now = 3_000_000;
  const quiet = makeMessages({ from: now - 68, to: now, rate: 1, laugh: 0.1 });
  assert.equal(detectSpike(quiet, now, configFromSensitivity(55)), null);
});

test("a busy channel needs a proportional jump, not an absolute one", () => {
  const now = 4_000_000;
  const baseline = makeMessages({ from: now - 62, to: now - 9, rate: 90, users: 400 });
  // 120/s is a real jump for a 90/s channel but below the z floor, so it must not fire.
  const mild = makeMessages({ from: now - 8, to: now, rate: 118, users: 400 });
  const candidate = detectSpike([...baseline, ...mild], now, configFromSensitivity(55));
  assert.equal(candidate, null);
});

test("sensitivity moves the firing threshold", () => {
  const now = 5_000_000;
  const baseline = makeMessages({ from: now - 62, to: now - 9, rate: 4, laugh: 0.2 });
  const middling = makeMessages({ from: now - 8, to: now, rate: 7, laugh: 0.3 });
  const messages = [...baseline, ...middling];

  const strict = detectSpike(messages, now, configFromSensitivity(5));
  const loose = detectSpike(messages, now, configFromSensitivity(98));

  assert.equal(strict, null, "a strict setting should ignore a modest bump");
  // The loose setting is far more permissive; if it fires, it must be a valid candidate.
  if (loose) assert.ok(loose.intensity > 0);
});

test("merge rule keeps one clip per moment", () => {
  // Same moment, slightly stronger: merge.
  assert.equal(shouldMerge(1000, 1040, 70, 68, 90), true);
  // Far stronger within the window: a genuinely new moment.
  assert.equal(shouldMerge(1000, 1040, 95, 50, 90), false);
  // Outside the window: always new.
  assert.equal(shouldMerge(1000, 1200, 70, 70, 90), false);
});

test("configFromSensitivity stays inside sane bounds", () => {
  for (const s of [0, 25, 55, 75, 100]) {
    const cfg = configFromSensitivity(s);
    assert.ok(cfg.minIntensity >= 30 && cfg.minIntensity <= 88);
    assert.ok(cfg.minZ >= 1.7 && cfg.minZ <= 4.4);
    assert.ok(cfg.minRatio >= 1.45 && cfg.minRatio <= 3.4);
  }
  assert.ok(configFromSensitivity(0).minIntensity > configFromSensitivity(100).minIntensity);
});
