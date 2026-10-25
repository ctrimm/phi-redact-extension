import test from "node:test";
import assert from "node:assert/strict";
import {
  scan,
  luhnOk,
  ssnValid,
  ibanValid,
  abaRoutingOk,
  redactText,
  restoreText,
} from "../src/lib/rules.js";

test("luhn: valid test card passes, invalid fails", () => {
  assert.equal(luhnOk("4111 1111 1111 1111"), true);
  assert.equal(luhnOk("4170755268738198"), false);
  assert.equal(luhnOk("123"), false);
});

test("ssn structure rules", () => {
  assert.equal(ssnValid("123-45-6789"), true);
  assert.equal(ssnValid("000-12-3456"), false);
  assert.equal(ssnValid("666-12-3456"), false);
  assert.equal(ssnValid("900-12-3456"), false);
  assert.equal(ssnValid("123-00-6789"), false);
  assert.equal(ssnValid("123-45-0000"), false);
});

test("iban mod-97", () => {
  assert.equal(ibanValid("GB29NWBK60161331926819"), true);
  assert.equal(ibanValid("GB29NWBK60161331926818"), false);
});

test("aba routing checksum", () => {
  assert.equal(abaRoutingOk("021000021"), true);
  assert.equal(abaRoutingOk("021000022"), false);
});

test("scan finds checksum-gated identifiers with exact spans", () => {
  const text =
    "SSN 123-45-6789, card 4111 1111 1111 1111, mail jsmith@example.com, call (312) 555-0167.";
  const ents = scan(text);
  const byLabel = Object.fromEntries(ents.map((e) => [e.label, e]));
  assert.equal(byLabel.SSN.text, "123-45-6789");
  assert.equal(text.slice(byLabel.SSN.start, byLabel.SSN.end), "123-45-6789");
  assert.equal(byLabel.CREDITCARD.text, "4111 1111 1111 1111");
  assert.equal(byLabel.EMAIL.text, "jsmith@example.com");
  assert.equal(byLabel.PHONE.text, "(312) 555-0167");
  assert.ok(ents.every((e) => e.source === "rule"));
});

test("scan rejects a Luhn-invalid card number", () => {
  const ents = scan("card 4170755268738198 on file");
  assert.equal(ents.filter((e) => e.label === "CREDITCARD").length, 0);
});

test("scan claims spans once (no overlaps)", () => {
  const ents = scan("on 03/14/1962 at 60601, MRN 1234567");
  for (let i = 0; i < ents.length; i++) {
    for (let j = i + 1; j < ents.length; j++) {
      assert.ok(
        ents[i].end <= ents[j].start || ents[j].end <= ents[i].start,
        `overlap: ${JSON.stringify(ents[i])} vs ${JSON.stringify(ents[j])}`,
      );
    }
  }
  assert.ok(ents.some((e) => e.label === "DATE" && e.text === "03/14/1962"));
  assert.ok(ents.some((e) => e.label === "MRN"));
});

test("redactText + restoreText round-trip", () => {
  const text = "call (312) 555-0167 or (312) 555-0167 again";
  const { redacted, mapping } = redactText(text);
  // Note: the SDK's standalone redactText numbers placeholders while
  // replacing back-to-front, so numbering runs in reverse document
  // order. The extension's output path (merge.applyPlaceholders)
  // renumbers in document order; redactText is kept behavior-identical
  // to the SDK for parity. What must hold either way: both occurrences
  // replaced, distinct placeholders, exact round-trip.
  assert.equal(redacted, "call [PHONE_2] or [PHONE_1] again");
  assert.equal(restoreText(redacted, mapping), text);
});
