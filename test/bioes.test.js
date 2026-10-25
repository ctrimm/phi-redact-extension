import test from "node:test";
import assert from "node:assert/strict";
import {
  splitText,
  decodeChunk,
  predictEntities,
  DEFAULT_THRESHOLD,
} from "../src/lib/bioes.js";

const LABELS = ["O", "B-NAME", "I-NAME", "E-NAME", "S-NAME", "S-DATE"];

// A whitespace tokenizer stub: one token per word, char offsets tracked.
// Returns bare ids (no specials); predictEntities adds [CLS]/[SEP].
function stubTokenizer() {
  return {
    specialIds: () => [101, 102],
    encode(text) {
      const ids = [];
      const offsets = [];
      const re = /\S+/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        ids.push(500 + ids.length);
        offsets.push([m.index, m.index + m[0].length]);
      }
      return { ids, offsets };
    },
  };
}

// Build a runLogits that puts `high` probability on the label chosen by
// plan(position) and spreads the rest.
function fakeRunLogits(plan, high = 0.97) {
  return async (ids) => {
    const seq = ids.length;
    const n = LABELS.length;
    const data = new Float32Array(seq * n);
    for (let i = 0; i < seq; i++) {
      const want = plan(i, ids);
      for (let j = 0; j < n; j++) {
        const p = j === want ? high : (1 - high) / (n - 1);
        data[i * n + j] = Math.log(p);
      }
    }
    return { data, dims: [1, seq, n] };
  };
}

test("decodeChunk: B/E span with mean score", () => {
  const text = "see John Smith today";
  const offs = [[0, 0], [0, 3], [4, 8], [9, 14], [15, 20], [0, 0]];
  const pred = [0, 0, 1, 3, 0, 0]; // specials, O, B-NAME, E-NAME, O, special
  const conf = [0.9, 0.9, 0.9, 1.0, 0.9, 0.9];
  const ents = decodeChunk(text, offs, pred, conf, LABELS);
  assert.equal(ents.length, 1);
  assert.equal(ents[0].label, "NAME");
  assert.equal(ents[0].text, "John Smith");
  assert.equal(ents[0].start, 4);
  assert.equal(ents[0].end, 14);
  assert.ok(Math.abs(ents[0].score - 0.95) < 1e-9);
});

test("decodeChunk: S- span and whitespace trim", () => {
  const text = "on  Monday  ";
  const offs = [[0, 0], [0, 2], [3, 10], [0, 0]];
  const pred = [0, 0, 5, 0];
  const conf = [0.9, 0.9, 0.77, 0.9];
  const ents = decodeChunk(text, offs, pred, conf, LABELS);
  assert.equal(ents.length, 1);
  assert.deepEqual(
    [ents[0].label, ents[0].text, ents[0].score],
    ["DATE", "Monday", 0.77],
  );
});

test("decodeChunk: malformed I- starts a new span (lenient, like the SDK)", () => {
  const text = "abc def";
  const offs = [[0, 0], [0, 3], [4, 7], [0, 0]];
  const pred = [0, 2, 3, 0]; // I-NAME then E-NAME with no B-
  const conf = [0.9, 0.9, 0.9, 0.9];
  const ents = decodeChunk(text, offs, pred, conf, LABELS);
  assert.equal(ents.length, 1);
  assert.equal(ents[0].text, "abc def");
});

test("predictEntities: threshold drops weak spans", async () => {
  const text = "John Smith left";
  // positions: 0=[CLS] 1=John 2=Smith 3=left 4=[SEP]
  const plan = (i) => [0, 1, 3, 0, 0][i] ?? 0;
  const weak = fakeRunLogits(plan, 0.5); // below the 0.6 threshold
  const none = await predictEntities(text, stubTokenizer(), weak, LABELS, {});
  assert.equal(none.length, 0);
  const strong = fakeRunLogits(plan, 0.95);
  const some = await predictEntities(text, stubTokenizer(), strong, LABELS, {});
  assert.equal(some.length, 1);
  assert.equal(some[0].text, "John Smith");
  assert.ok(some[0].score >= DEFAULT_THRESHOLD);
});

test("splitText: short text stays whole", () => {
  const chunks = splitText("hello world", (t) => t.split(" ").length, 384);
  assert.deepEqual(chunks, [{ text: "hello world", offset: 0 }]);
});

test("splitText: long text chunks with overlap and full coverage", () => {
  const words = Array.from({ length: 500 }, (_, i) => `w${i}`).join(" ");
  const count = (t) => (t.match(/\S+/g) ?? []).length;
  const chunks = splitText(words, count, 100);
  assert.ok(chunks.length >= 5);
  // Every chunk within the token budget (maxLen - 2 body tokens, and the
  // stub count adds 2 specials -> compare against maxLen).
  for (const c of chunks) assert.ok(count(c.text) <= 100);
  // Coverage: concatenating chunk spans covers the whole string.
  assert.equal(chunks[0].offset, 0);
  const last = chunks[chunks.length - 1];
  assert.equal(last.offset + last.text.length, words.length);
  // Overlap: consecutive chunks overlap in characters.
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1];
    assert.ok(chunks[i].offset < prev.offset + prev.text.length);
  }
});
