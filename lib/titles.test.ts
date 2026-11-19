import test from "node:test";
import assert from "node:assert/strict";
import { pickUnused, uniqueCaption, uniqueTitle, uniqueTitleChanges } from "./titles.ts";

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

test("the first unused title option wins over numbering", () => {
  const options = ["Insane clutch", "He read the ult", "One hp comeback"];
  assert.equal(pickUnused(options, ["insane clutch!"]), "He read the ult");
  assert.equal(pickUnused(options, []), "Insane clutch");
  assert.equal(pickUnused(["a", "b"], ["A", "B"]), null);
});

test("an unused caption is left alone", () => {
  assert.equal(uniqueCaption("BRO REALLY DID THAT", ["OTHER CAPTION"], "Some title"), "BRO REALLY DID THAT");
});

test("a caption may not repeat another clip's caption", () => {
  assert.equal(uniqueCaption("BRO REALLY DID THAT", ["bro really did that"], "Other"), "BRO REALLY DID THAT #2");
});

test("a caption may not be its own title", () => {
  assert.equal(
    uniqueCaption("That went badly", [], "That went badly", ["THAT WENT BADLY — MINECRAFT"]),
    "THAT WENT BADLY — MINECRAFT",
  );
});

test("every clip gets distinct copy from the same source phrases", () => {
  const titles: string[] = [];
  const captions: string[] = [];
  for (let i = 0; i < 6; i++) {
    const title = uniqueTitle("Insane clutch", titles);
    titles.push(title);
    captions.push(uniqueCaption("BRO REALLY DID THAT", captions, title));
  }
  assert.equal(new Set(titles).size, titles.length);
  assert.equal(new Set(captions.map((c) => c.toLowerCase())).size, captions.length);
  for (let i = 0; i < 6; i++) {
    assert.notEqual(captions[i].trim().toLowerCase(), titles[i].trim().toLowerCase());
  }
});
