import test from "node:test";
import assert from "node:assert/strict";
import {
  assembleOcrText,
  boxesForEntities,
  snippetFor,
} from "../src/lib/spanImage.js";

const words = [
  { text: "Patient", bbox: { x0: 0, y0: 0, x1: 70, y1: 12 } },
  { text: "John", bbox: { x0: 75, y0: 0, x1: 110, y1: 12 } },
  { text: "Smith", bbox: { x0: 115, y0: 0, x1: 160, y1: 12 } },
  { text: "resting", bbox: { x0: 165, y0: 0, x1: 220, y1: 12 } },
];

test("assembleOcrText joins with single spaces and tracks ranges", () => {
  const { text, words: kept } = assembleOcrText(words);
  assert.equal(text, "Patient John Smith resting");
  assert.deepEqual([kept[1].start, kept[1].end], [8, 12]);
  assert.equal(text.slice(kept[2].start, kept[2].end), "Smith");
});

test("assembleOcrText drops empty words", () => {
  const { text, words: kept } = assembleOcrText([
    { text: "  ", bbox: null },
    { text: "hi", bbox: { x0: 0, y0: 0, x1: 5, y1: 5 } },
  ]);
  assert.equal(text, "hi");
  assert.equal(kept.length, 1);
});

test("boxesForEntities: intersecting words only, padded and clipped", () => {
  const { words: kept } = assembleOcrText(words);
  const entity = { start: 8, end: 18, label: "NAME_PATIENT" }; // John Smith
  const boxes = boxesForEntities([entity], kept, {
    pad: 2,
    width: 200,
    height: 20,
  });
  assert.equal(boxes.length, 2);
  assert.deepEqual(boxes[0], { x0: 73, y0: 0, x1: 112, y1: 14 });
  assert.deepEqual(boxes[1], { x0: 113, y0: 0, x1: 162, y1: 14 });
});

test("boxesForEntities: partial word overlap counts", () => {
  const { words: kept } = assembleOcrText(words);
  const entity = { start: 10, end: 11, label: "X" }; // inside "John"
  assert.equal(boxesForEntities([entity], kept, {}).length, 1);
});

test("snippetFor shows context around the span", () => {
  const text = "the patient John Smith was seen today";
  const s = snippetFor(text, { start: 12, end: 22 }, 5);
  assert.equal(s, "...ient John Smith was ...");
});
