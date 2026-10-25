import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WordPieceTokenizer } from "../src/lib/tokenizer.js";
import { NeuralEngine } from "../src/lib/neural.js";
import { scanAll } from "../src/lib/merge.js";

/**
 * End-to-end parity test against the SDK's Python engine.
 *
 * Runs the real phi-redact v9 INT8 model through the vendored
 * onnxruntime-web bundle (the exact files the extension ships) and
 * compares entities with fixtures/reference.json, which was generated
 * by the SDK's Python OnnxEngine + rules on the same model.
 *
 * The model file is NOT committed (the extension downloads it from
 * Hugging Face at runtime). This test skips unless the model is found
 * at PHI_MODEL_PATH or test/fixtures/model/phi-redact-v9-int8.onnx.
 * Get it with:
 *   curl -L -o test/fixtures/model/phi-redact-v9-int8.onnx \
 *     https://huggingface.co/CDT5058/phi-redact/resolve/main/phi-redact-v9-int8.onnx
 */

const modelPath =
  process.env.PHI_MODEL_PATH ??
  new URL("./fixtures/model/phi-redact-v9-int8.onnx", import.meta.url).pathname;

const fixturesDir = new URL("./fixtures/", import.meta.url).pathname;
const reference = JSON.parse(
  readFileSync(join(fixturesDir, "reference.json"), "utf8"),
);
const tags = JSON.parse(readFileSync(join(fixturesDir, "tags.json"), "utf8"));
const tokJson = JSON.parse(
  readFileSync(join(fixturesDir, "tokenizer.json"), "utf8"),
);

const skip = !existsSync(modelPath);

test("onnx parity with the SDK Python engine", { skip }, async () => {
  const ort = await import("../vendor/ort/ort.wasm.bundle.min.mjs");
  ort.env.wasm.wasmPaths = new URL("../vendor/ort/", import.meta.url).pathname;
  ort.env.wasm.numThreads = 1;

  const engine = new NeuralEngine(
    ort,
    new WordPieceTokenizer(tokJson),
    tags,
  );
  await engine.init(new Uint8Array(readFileSync(modelPath)));

  const key = (e) => `${e.start}|${e.end}|${e.label}|${e.source}`;
  for (const [name, fx] of Object.entries(reference.redact)) {
    const neural = await engine.predict(fx.text);
    const result = scanAll(fx.text, neural);
    const mine = new Map(result.entities.map((e) => [key(e), e]));
    const theirs = new Map(fx.entities.map((e) => [key(e), e]));

    if (name === "long") {
      // Documented divergence: the SDK engine's neural scan silently
      // truncates at 256 tokens (tokenizer.json truncation defeats its
      // chunking); the extension chunks fully. So every reference
      // entity must be found verbatim — except a neural span cut off
      // mid-entity by the truncation edge (the reference has 'Maria'
      // at 1808-1813, score 0.89: half a name). Those are accepted when
      // the extension finds a same-label neural span covering them
      // (the full 'Maria Gonzalez'). Rule entities have no such edge
      // and must match verbatim.
      for (const [k, ref] of theirs) {
        if (mine.has(k)) continue;
        assert.equal(ref.source, "neural", `long: missing rule entity ${k}`);
        const covering = result.entities.some(
          (e) =>
            e.source === "neural" &&
            e.label === ref.label &&
            e.start <= ref.start &&
            e.end >= ref.end,
        );
        assert.ok(covering, `long: no covering span for reference ${k}`);
      }
      continue;
    }
    assert.deepEqual(
      [...mine.keys()].sort(),
      [...theirs.keys()].sort(),
      `${name}: entity sets differ`,
    );
    // Scores should track closely (same quantized graph; wasm vs CPU
    // numerics may differ in the last decimals).
    for (const [k, e] of mine) {
      const ref = theirs.get(k);
      if (e.source === "neural" && ref.score != null) {
        assert.ok(
          Math.abs(e.score - ref.score) < 0.02,
          `${name}: score drift on ${k}: ${e.score} vs ${ref.score}`,
        );
      }
    }
    assert.equal(result.redacted, fx.redacted, `${name}: redacted text`);
  }
});
