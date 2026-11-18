import test from "node:test";
import assert from "node:assert/strict";
import {
  boxFromHint,
  hintFromText,
  normaliseHint,
  parseWebcamBox,
  storedWebcam,
} from "./webcam.ts";

test("a bottom-left face cam maps inside the frame", () => {
  const box = boxFromHint({ visible: true, region: "bottom-left", size: "medium" });
  assert.ok(box);
  assert.equal(box!.x, 0);
  assert.ok(box!.w > 0.2 && box!.w < 0.4);
  assert.ok(box!.y + box!.h <= 1.0001);
});

test("a large bottom-right cam stays inside the frame", () => {
  const box = boxFromHint({ visible: true, region: "bottom-right", size: "large" });
  assert.ok(box);
  assert.ok(box!.x >= 0 && box!.x + box!.w <= 1.0001);
  assert.ok(box!.y >= 0 && box!.y + box!.h <= 1.0001);
});

test("no webcam or an unknown region yields no crop", () => {
  assert.equal(boxFromHint({ visible: false, region: "bottom-left", size: "medium" }), null);
  assert.equal(boxFromHint({ visible: true, region: "somewhere", size: "medium" }), null);
  assert.equal(boxFromHint(normaliseHint({ webcam: false })), null);
});

test("model output is validated, not trusted", () => {
  assert.equal(normaliseHint(null), null);
  assert.equal(normaliseHint({ webcam: "yes", region: "bottom-left" }), null);
  assert.deepEqual(normaliseHint({ webcam: true, region: "TOP-RIGHT", size: "huge" }), {
    visible: true,
    region: "top-right",
    size: "medium",
  });
});

test("prose answers are recovered when the model skips JSON", () => {
  assert.deepEqual(hintFromText("The webcam is in the bottom left corner, fairly small."), {
    visible: true,
    region: "bottom-left",
    size: "small",
  });
  assert.equal(hintFromText("No webcam visible in this frame."), null);
  assert.equal(hintFromText("The player is in the middle of the map."), null);
});

test("stored boxes round-trip and malformed ones are rejected", () => {
  const stored = storedWebcam(
    { visible: true, region: "bottom-left", size: "medium" },
    { x: 0.01, y: 0.65, w: 0.28, h: 0.3 },
  );
  assert.deepEqual(parseWebcamBox(stored), { x: 0.01, y: 0.65, w: 0.28, h: 0.3 });
  assert.equal(parseWebcamBox("{\"box\":{\"x\":0.5,\"y\":0.9,\"w\":0.3,\"h\":0.3}}"), null);
  assert.equal(parseWebcamBox("not json"), null);
  assert.equal(parseWebcamBox(null), null);
});
