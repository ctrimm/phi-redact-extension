import test from "node:test";
import assert from "node:assert/strict";
import { mergeEntities, applyPlaceholders, scanAll } from "../src/lib/merge.js";

const rule = (start, end, label, text) => ({ start, end, label, text, source: "rule" });
const neural = (start, end, label, text, score) => ({
  start, end, label, text, source: "neural", score,
});

test("merge: rules win overlaps with neural spans", () => {
  const text = "SSN 123-45-6789 here";
  const rules = [rule(4, 15, "SSN", "123-45-6789")];
  const neur = [neural(4, 15, "GOVERNMENT_ID", "123-45-6789", 0.99)];
  const merged = mergeEntities(rules, neur);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, "rule");
});

test("merge: neural-neural overlaps keep the higher score", () => {
  const neur = [
    neural(0, 5, "NAME_PATIENT", "John ", 0.7),
    neural(0, 10, "NAME_PATIENT", "John Smith", 0.9),
  ];
  const merged = mergeEntities([], neur);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].end, 10);
});

test("merge: non-overlapping spans from both layers survive, sorted", () => {
  const merged = mergeEntities(
    [rule(20, 30, "PHONE", "x")],
    [neural(0, 4, "NAME_PATIENT", "y", 0.9)],
  );
  assert.deepEqual(merged.map((e) => e.label), ["NAME_PATIENT", "PHONE"]);
});

test("placeholders: numbered per label in document order", () => {
  const text = "John called 312-555-0167 and 415-555-0132";
  const ents = [
    neural(0, 4, "NAME_PATIENT", "John", 0.9),
    rule(12, 24, "PHONE", "312-555-0167"),
    rule(29, 41, "PHONE", "415-555-0132"),
  ];
  const { redacted, mapping } = applyPlaceholders(text, ents);
  assert.equal(redacted, "[NAME_PATIENT_1] called [PHONE_1] and [PHONE_2]");
  assert.equal(mapping["[PHONE_2]"], "415-555-0132");
});

test("scanAll: SDK result shape with counts and engine tag", () => {
  const r = scanAll("email jsmith@example.com", []);
  assert.equal(r.engine, "rules");
  assert.equal(r.counts.EMAIL, 1);
  assert.equal(r.redacted, "email [EMAIL_1]");
  const r2 = scanAll("John left", [neural(0, 4, "NAME_PATIENT", "John", 0.95)]);
  assert.equal(r2.engine, "rules+onnx");
  assert.equal(r2.redacted, "[NAME_PATIENT_1] left");
});
