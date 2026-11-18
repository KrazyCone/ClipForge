import test from "node:test";
import assert from "node:assert/strict";
import { uniqueTitle, uniqueTitleChanges } from "./titles.ts";

test("an unused title is left alone", () => {
  assert.equal(uniqueTitle("Insane clutch", ["Other title"]), "Insane clutch");
});

test("a duplicate gets the first free variant", () => {
  assert.equal(
    uniqueTitle("Insane clutch", ["Insane clutch"], ["Insane clutch — Valorant"]),
    "Insane clutch — Valorant",
  );
});

test("numbering is the fallback when the variant is taken too", () => {
  const title = uniqueTitle("Insane clutch", ["Insane clutch", "Insane clutch — Valorant"]);
  assert.equal(title, "Insane clutch (2)");
});

test("case and punctuation do not hide a duplicate", () => {
  assert.equal(uniqueTitle("INSANE clutch!", ["insane clutch"]), "INSANE clutch! (2)");
});

test("changes rename only the later duplicates", () => {
  const changes = uniqueTitleChanges([
    { id: "a", title: "Same" },
    { id: "b", title: "same" },
    { id: "c", title: "Different" },
    { id: "d", title: "Same" },
  ]);
  assert.deepEqual(changes, [
    { id: "b", title: "same (2)" },
    { id: "d", title: "Same (3)" },
  ]);
});

test("blank titles get a real one", () => {
  assert.equal(uniqueTitle("", []), "Twitch moment");
});
