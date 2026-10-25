import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WordPieceTokenizer } from "../src/lib/tokenizer.js";

const tokJson = JSON.parse(
  readFileSync(new URL("./fixtures/tokenizer.json", import.meta.url), "utf8"),
);
const reference = JSON.parse(
  readFileSync(new URL("./fixtures/reference.json", import.meta.url), "utf8"),
);
const tok = new WordPieceTokenizer(tokJson);

// Fixtures in fixtures/reference.json were generated with the reference
// implementation (Hugging Face `tokenizers`, via the SDK's Python
// engine) on the shipped v9 tokenizer.json. The JS port must reproduce
// ids AND character offsets exactly.
for (const [name, fx] of Object.entries(reference.tokenizer)) {
  test(`tokenizer parity: ${name}`, () => {
    const enc = tok.encode(fx.text);
    assert.deepEqual(enc.ids, fx.ids);
    assert.deepEqual(enc.offsets, fx.offsets);
  });
}

test("special ids come from the tokenizer vocab", () => {
  assert.deepEqual(tok.specialIds(), [101, 102]);
});

test("truncation is applied by default, disabled on request", () => {
  const long = reference.tokenizer.long.text;
  assert.equal(tok.encode(long).ids.length, 256);
  assert.ok(tok.encode(long, { truncate: false }).ids.length > 256);
});

test("word containing an unrepresentable char becomes a single [UNK]", () => {
  // The unicorn is not in the BERT vocab and cannot be pieced from
  // subwords, so the whole word falls back to [UNK] (WordPiece rule).
  const enc = tok.encode("abcd\u{1F984}xyz");
  // [CLS] + [UNK] + [SEP]; offsets in UTF-16 code units (4 + 2 + 3).
  assert.deepEqual(enc.ids, [101, 100, 102]);
  assert.deepEqual(enc.offsets[1], [0, 9]);
});

test("empty text encodes to just the specials", () => {
  const enc = tok.encode("");
  assert.deepEqual(enc.ids, [101, 102]);
});
