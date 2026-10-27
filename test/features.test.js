import test from "node:test";
import assert from "node:assert/strict";
import {
  applyPlaceholders,
  checkRecognizer,
  denylistSpans,
  hashToken,
  maskValue,
  mergeEntities,
  recognizerSpans,
  scanAll,
  sha256Hex,
} from "../src/lib/merge.js";

/**
 * SDK 0.4.0 / 0.5.0 feature parity tests for the ported engine.
 * Semantics (and the hash vectors) are pinned to the phi-redact SDK's
 * TypeScript suite — same inputs must give the same outputs.
 */

const neural = (start, end, label, text, score) => ({
  start, end, label, text, source: "neural", score,
});

// ---------------------------------------------------------------------------
// SHA-256 + hash operator (shared vectors, pinned in the SDK suites too)
// ---------------------------------------------------------------------------

test("sha256Hex: NIST known answers", () => {
  assert.equal(
    sha256Hex(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assert.equal(
    sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(
    sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
});

const HASH_VECTORS = [
  ["", "SSN", "234-56-7890", "[SSN_5f6c8b16]"],
  ["pepper", "SSN", "234-56-7890", "[SSN_e2e9f611]"],
  ["", "EMAIL", "jane@example.com", "[EMAIL_34da503d]"],
  ["s3cret-salt", "NAME_PATIENT", "Maria Santos", "[NAME_PATIENT_09a6b457]"],
  ["parity-salt", "PHONE", "415-555-0132", "[PHONE_954b7ae0]"],
];

test("hashToken: shared SDK vectors", () => {
  for (const [salt, label, value, expected] of HASH_VECTORS) {
    assert.equal(hashToken(label, value, salt), expected);
  }
});

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------

test("operator label: <LABEL> rendering, irreversible", () => {
  const r = scanAll("SSN 234-56-7890", [], { operator: "label" });
  assert.equal(r.redacted, "SSN <SSN>");
  assert.deepEqual(r.mapping, {});
});

test("operator mask: structured IDs keep last 4, names mask to length", () => {
  assert.equal(maskValue("SSN", "234-56-7890"), "***-**-7890");
  assert.equal(maskValue("NAME_PATIENT", "Maria"), "*****");
  const r = scanAll("SSN 234-56-7890", [], { operator: "mask" });
  assert.equal(r.redacted, "SSN ***-**-7890");
});

test("operator hash: consistent across documents, salt-dependent", () => {
  const a = scanAll("SSN 234-56-7890", [], { operator: "hash", salt: "s" });
  const b = scanAll("the SSN is 234-56-7890 ok", [], { operator: "hash", salt: "s" });
  const c = scanAll("SSN 234-56-7890", [], { operator: "hash", salt: "x" });
  assert.match(a.redacted, /\[SSN_[0-9a-f]{8}\]/);
  assert.ok(b.redacted.includes(a.redacted.split(" ")[1]));
  assert.notEqual(a.redacted, c.redacted);
  assert.deepEqual(a.mapping, {});
});

test("operator remove: span deleted", () => {
  const r = scanAll("SSN 234-56-7890.", [], { operator: "remove" });
  assert.equal(r.redacted, "SSN .");
});

test("operator unknown: throws", () => {
  assert.throws(() => scanAll("x", [], { operator: "bogus" }), /unknown operator/);
});

test("defaults reproduce the pre-0.4 output byte-for-byte", () => {
  const text = "Call Jane Doe at 415-555-0132 about SSN 234-56-7890.";
  const r = scanAll(text, []);
  assert.equal(r.redacted, "Call Jane Doe at [PHONE_1] about SSN [SSN_1].");
  assert.deepEqual(r.review, []);
});

// ---------------------------------------------------------------------------
// Allow / deny lists
// ---------------------------------------------------------------------------

test("allowlist: named value is never redacted (case-insensitive)", () => {
  const r = scanAll("Call 415-555-0132", [], { allowlist: ["415-555-0132"] });
  assert.equal(r.redacted, "Call 415-555-0132");
  assert.equal(r.entities.length, 0);
});

test("denylist: term redacted as CUSTOM with no other detection", () => {
  const r = scanAll("The launch codename is Nightingale.", [], {
    denylist: ["Nightingale"],
  });
  assert.equal(r.redacted, "The launch codename is [CUSTOM_1].");
  assert.equal(r.entities[0].source, "denylist");
});

test("denylist wins over allowlist for the same term", () => {
  const r = scanAll("Nightingale", [], {
    allowlist: ["Nightingale"],
    denylist: ["nightingale"],
  });
  assert.equal(r.redacted, "[CUSTOM_1]");
});

test("denylist spans are word-boundary aware", () => {
  const spans = denylistSpans("a catalog of cats", ["cat"]);
  assert.equal(spans.length, 0);
});

test("lists flow through scans: allow + deny + operator together", () => {
  const r = scanAll("Call 415-555-0132 about Nightingale", [], {
    operator: "label",
    allowlist: ["415-555-0132"],
    denylist: ["Nightingale"],
  });
  assert.equal(r.redacted, "Call 415-555-0132 about <CUSTOM>");
});

// ---------------------------------------------------------------------------
// Custom recognizers
// ---------------------------------------------------------------------------

const EMP = [{ label: "EMPLOYEE_ID", patterns: ["EMP-\\d{6}"] }];

test("recognizer: custom label, recognizer source, base score gates in", () => {
  const r = scanAll("Badge EMP-123456 issued", [], { recognizers: EMP });
  assert.equal(r.redacted, "Badge [EMPLOYEE_ID_1] issued");
  assert.equal(r.entities[0].source, "recognizer");
  assert.equal(r.entities[0].score, 0.85);
});

test("recognizer: base score below the global gate is dropped", () => {
  const r = scanAll("Badge EMP-123456", [], {
    recognizers: [{ label: "EMPLOYEE_ID", patterns: ["EMP-\\d{6}"], score: 0.5 }],
  });
  assert.equal(r.entities.length, 0);
  assert.equal(r.redacted, "Badge EMP-123456");
});

test("recognizer: context boost lifts a match over the gate", () => {
  const rec = [{
    label: "EMPLOYEE_ID",
    patterns: ["\\d{6}"],
    score: 0.55,
    context: ["badge"],
  }];
  const withCtx = scanAll("badge number 123456 here", [], { recognizers: rec });
  assert.equal(withCtx.entities.length, 1);
  assert.equal(withCtx.entities[0].score, 0.65);
  const noCtx = scanAll("the number 123456 here", [], { recognizers: rec });
  assert.equal(noCtx.entities.length, 0);
});

test("recognizer: requireContext drops uncontextualized matches", () => {
  const rec = [{
    label: "EMPLOYEE_ID",
    patterns: ["\\d{6}"],
    score: 0.95,
    context: ["badge"],
    requireContext: true,
  }];
  assert.equal(scanAll("the number 123456", [], { recognizers: rec }).entities.length, 0);
  assert.equal(scanAll("badge 123456", [], { recognizers: rec }).entities.length, 1);
});

test("recognizer: named luhn validator gates matches", () => {
  const rec = [{
    label: "CARD",
    patterns: ["\\d{16}"],
    validator: "luhn",
  }];
  assert.equal(
    scanAll("card 4111111111111111", [], { recognizers: rec }).entities.length, 1);
  assert.equal(
    scanAll("card 1234567812345678", [], { recognizers: rec }).entities.length, 0);
});

test("recognizer: group selects the value span, excluding the anchor", () => {
  const spans = recognizerSpans("employee: EMP-123456", [{
    label: "EMPLOYEE_ID",
    patterns: ["employee: (EMP-\\d{6})"],
    group: 1,
  }]);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].text, "EMP-123456");
  assert.equal(spans[0].start, 10);
});

test("recognizer: precedence — rule beats recognizer, recognizer beats neural", () => {
  const text = "SSN 234-56-7890";
  const rec = [{ label: "ID_NUMBER", patterns: ["\\d{3}-\\d{2}-\\d{4}"] }];
  const r = scanAll(text, [], { recognizers: rec });
  assert.equal(r.entities[0].label, "SSN");
  assert.equal(r.entities[0].source, "rule");

  const merged = mergeEntities(
    [],
    [neural(0, 4, "NAME_PATIENT", "John", 0.99)],
    [{ start: 0, end: 4, label: "ALIAS", text: "John", source: "recognizer", score: 0.85 }],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].label, "ALIAS");
});

test("recognizer: invalid config throws; checkRecognizer reports it", () => {
  assert.throws(
    () => recognizerSpans("x", [{ label: "X", patterns: ["(["] }]),
    /invalid pattern/,
  );
  assert.equal(typeof checkRecognizer({ label: "X", patterns: ["(["] }), "string");
  assert.equal(checkRecognizer({ label: "X", patterns: ["\\d+"] }), null);
  assert.equal(typeof checkRecognizer({ label: "", patterns: [] }), "string");
  assert.equal(
    typeof checkRecognizer({ label: "X", patterns: ["a"], requireContext: true }),
    "string",
  );
});

test("recognizer: allowlist drops a recognizer span; denylist wins an overlap", () => {
  const rec = [{ label: "EMPLOYEE_ID", patterns: ["EMP-\\d{6}"] }];
  const allowed = scanAll("EMP-123456", [], {
    recognizers: rec,
    allowlist: ["EMP-123456"],
  });
  assert.equal(allowed.entities.length, 0);
  const denied = scanAll("EMP-123456", [], {
    recognizers: rec,
    denylist: ["EMP-123456"],
  });
  assert.equal(denied.entities[0].source, "denylist");
});

// ---------------------------------------------------------------------------
// Per-label thresholds + review mode
// ---------------------------------------------------------------------------

test("gate: neural span below the global threshold is dropped, review empty", () => {
  const r = scanAll("John left", [neural(0, 4, "NAME_PATIENT", "John", 0.55)]);
  assert.equal(r.entities.length, 0);
  assert.deepEqual(r.review, []);
  assert.equal(r.redacted, "John left");
});

test("gate: the extension threshold option is the global gate", () => {
  const span = neural(0, 4, "NAME_PATIENT", "John", 0.55);
  const r = scanAll("John left", [span], { threshold: 0.5 });
  assert.equal(r.entities.length, 1);
  assert.equal(r.redacted, "[NAME_PATIENT_1] left");
});

test("review: span in the band becomes a candidate — not redacted, not counted", () => {
  const r = scanAll("John left", [neural(0, 4, "NAME_PATIENT", "John", 0.55)], {
    reviewMargin: 0.15,
  });
  assert.equal(r.entities.length, 0);
  assert.equal(r.redacted, "John left");
  assert.deepEqual(r.counts, {});
  assert.equal(r.review.length, 1);
  assert.deepEqual(r.review[0], {
    start: 0, end: 4, label: "NAME_PATIENT", text: "John",
    score: 0.55, source: "neural",
  });
});

test("review: span below the band floor is dropped, not reviewed", () => {
  const r = scanAll("John left", [neural(0, 4, "NAME_PATIENT", "John", 0.4)], {
    reviewMargin: 0.15,
  });
  assert.equal(r.review.length, 0);
});

test("review: span exactly at the floor is reviewed", () => {
  const r = scanAll("John left", [neural(0, 4, "NAME_PATIENT", "John", 0.45)], {
    reviewMargin: 0.15,
  });
  assert.equal(r.review.length, 1);
});

test("thresholds: per-label override raises the gate into the review band", () => {
  const r = scanAll("John left", [neural(0, 4, "NAME_PATIENT", "John", 0.8)], {
    thresholds: { NAME_PATIENT: 0.9 },
    reviewMargin: 0.15,
  });
  assert.equal(r.entities.length, 0);
  assert.equal(r.review.length, 1);
});

test("thresholds: per-label override lowers the gate", () => {
  const r = scanAll("John left", [neural(0, 4, "NAME_PATIENT", "John", 0.55)], {
    thresholds: { NAME_PATIENT: 0.5 },
  });
  assert.equal(r.entities.length, 1);
});

test("thresholds: rule spans are never gated and never reviewed", () => {
  const r = scanAll("SSN 234-56-7890", [], {
    thresholds: { SSN: 0.99 },
    reviewMargin: 0.5,
  });
  assert.equal(r.redacted, "SSN [SSN_1]");
  assert.equal(r.review.length, 0);
});

test("thresholds: invalid values throw", () => {
  assert.throws(
    () => scanAll("x", [], { thresholds: { NAME_PATIENT: 1.5 } }),
    /outside \[0, 1\]/,
  );
  assert.throws(
    () => scanAll("x", [], { reviewMargin: -0.1 }),
    /outside \[0, 1\]/,
  );
});

test("review: recognizer spans can land in the band too", () => {
  const r = scanAll("Badge EMP-123456", [], {
    recognizers: [{ label: "EMPLOYEE_ID", patterns: ["EMP-\\d{6}"], score: 0.5 }],
    reviewMargin: 0.15,
  });
  assert.equal(r.entities.length, 0);
  assert.equal(r.review.length, 1);
  assert.equal(r.review[0].source, "recognizer");
});

test("combined: operator + recognizer + review in one scan", () => {
  const text = "Badge EMP-123456 for John";
  const r = scanAll(text, [neural(21, 25, "NAME_PATIENT", "John", 0.52)], {
    operator: "mask",
    recognizers: EMP,
    reviewMargin: 0.15,
  });
  assert.equal(r.redacted, "Badge ********** for John");
  assert.equal(r.review.length, 1);
  assert.equal(r.review[0].label, "NAME_PATIENT");
});

test("applyPlaceholders: promoted review candidate renders in document order", () => {
  const text = "John called 415-555-0132";
  const kept = [{ start: 12, end: 24, label: "PHONE", text: "415-555-0132", source: "rule" }];
  const promoted = { start: 0, end: 4, label: "NAME_PATIENT", text: "John", source: "neural", score: 0.55 };
  const { redacted } = applyPlaceholders(text, [...kept, promoted]);
  assert.equal(redacted, "[NAME_PATIENT_1] called [PHONE_1]");
});
