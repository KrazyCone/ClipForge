import test from "node:test";
import assert from "node:assert/strict";
import {
  boxFromHint,
  canonicalRegion,
  hintFromText,
  normaliseHint,
  parseWebcamBox,
  storedWebcam,
  WEBCAM_REGION_OPTIONS,
} from "./webcam.ts";

test("a bottom-left face cam maps inside the frame", () => {
  const box = boxFromHint({ visible: true, region: "bottom-left", size: "medium" });
  assert.ok(box);
  // Centred in the bottom-left cell, so the box starts just inside the frame.
  assert.ok(box!.x >= 0 && box!.x < 0.1);
  assert.ok(box!.w > 0.2 && box!.w < 0.4);
  assert.ok(box!.y + box!.h <= 1.0001);
});

test("a large bottom-right cam stays inside the frame", () => {
  const box = boxFromHint({ visible: true, region: "bottom-right", size: "large" });
  assert.ok(box);
  assert.ok(box!.x >= 0 && box!.x + box!.w <= 1.0001);
  assert.ok(box!.y >= 0 && box!.y + box!.h <= 1.0001);
  // It should sit in the bottom-right area, not span the whole frame.
  assert.ok(box!.x > 0.6 && box!.y > 0.55);
  assert.ok(box!.w < 0.4 && box!.h < 0.5);
});

test("no webcam or an unknown region yields no crop", () => {
  assert.equal(boxFromHint({ visible: false, region: "bottom-left", size: "medium" }), null);
  assert.equal(boxFromHint({ visible: true, region: "somewhere", size: "medium" }), null);
  assert.equal(boxFromHint(normaliseHint({ webcam: false })), null);
});

test("model output is validated, not trusted", () => {
  assert.equal(normaliseHint(null), null);
  assert.equal(normaliseHint({ webcam: "no", region: "bottom-left" }), null);
  assert.equal(normaliseHint({ webcam: false, region: "bottom-left" }), null);
  assert.deepEqual(normaliseHint({ webcam: true, region: "TOP-RIGHT", size: "huge" }), {
    visible: true,
    region: "top-right",
    size: "medium",
  });
  // A guess the model itself is unsure about must not crop a random corner.
  assert.equal(
    normaliseHint({ webcam: true, region: "bottom-left", size: "medium", confidence: 30 }),
    null,
  );
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

test("the middle row is offered and every spelling maps onto it", () => {
  const values = WEBCAM_REGION_OPTIONS.map((option) => option.value);
  assert.ok(values.includes("mid-left"));
  assert.ok(values.includes("mid-right"));
  assert.equal(values.length, 9);

  for (const spelling of ["middle left", "left-middle", "center left", "left side", "left"]) {
    assert.equal(canonicalRegion(spelling), "mid-left", spelling);
  }
  for (const spelling of ["middle right", "right-middle", "centre right", "right side", "right"]) {
    assert.equal(canonicalRegion(spelling), "mid-right", spelling);
  }
  assert.equal(canonicalRegion("bottom left corner"), "bottom-left");
  assert.equal(canonicalRegion("upper right"), "top-right");
});

test("a half-left webcam is detected without naming the height", () => {
  assert.deepEqual(hintFromText("The face cam sits on the left side of the frame."), {
    visible: true,
    region: "mid-left",
    size: "medium",
  });
  assert.deepEqual(normaliseHint({ webcam: "true", region: "middle left", size: "large" }), {
    visible: true,
    region: "mid-left",
    size: "large",
  });
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
