import test from "node:test";
import assert from "node:assert/strict";
import {
  routeFile,
  redactedName,
  withinScanSize,
  MAX_SCAN_BYTES,
} from "../src/lib/fileTypes.js";

test("routeFile: pdf by mime or extension", () => {
  assert.equal(routeFile({ name: "labs.pdf", type: "application/pdf" }), "pdf");
  assert.equal(routeFile({ name: "labs.PDF", type: "" }), "pdf");
});

test("routeFile: images", () => {
  assert.equal(routeFile({ name: "a.png", type: "image/png" }), "image");
  assert.equal(routeFile({ name: "a.jpg", type: "image/jpeg" }), "image");
  assert.equal(routeFile({ name: "a.webp", type: "" }), "image");
  assert.equal(routeFile({ name: "a.gif", type: "image/gif" }), "other");
});

test("routeFile: text kinds", () => {
  assert.equal(routeFile({ name: "notes.txt", type: "text/plain" }), "text");
  assert.equal(routeFile({ name: "notes.md", type: "" }), "text");
  assert.equal(routeFile({ name: "data.csv", type: "text/csv" }), "text");
  assert.equal(routeFile({ name: "archive.zip", type: "application/zip" }), "other");
  assert.equal(routeFile({ name: "noext", type: "" }), "other");
});

test("redactedName inserts .redacted before the extension", () => {
  assert.equal(redactedName("photo.png"), "photo.redacted.png");
  assert.equal(redactedName("notes"), "notes.redacted");
  assert.equal(redactedName("labs.pdf", "txt"), "labs.redacted.txt");
});

test("withinScanSize enforces the v1 envelope", () => {
  assert.equal(withinScanSize({ size: 1024 }), true);
  assert.equal(withinScanSize({ size: MAX_SCAN_BYTES + 1 }), false);
});
