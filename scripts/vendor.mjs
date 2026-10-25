#!/usr/bin/env node
/**
 * Copy the third-party runtime files the extension ships into vendor/.
 *
 * MV3 forbids remotely hosted code, so onnxruntime-web, pdf.js and
 * tesseract.js must be bundled with the extension. Only the files the
 * extension actually loads are copied (onnxruntime-web alone ships
 * ~135 MB of backend variants in its dist folder; we need ~14 MB).
 *
 * Run: npm install && npm run vendor
 * The copied files are committed so the extension can be loaded
 * unpacked with no build step.
 */
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nm = (p) => join(root, "node_modules", p);
const out = (p) => join(root, "vendor", p);

const FILES = [
  // onnxruntime-web: WASM backend bundle + the simd-threaded binary and
  // its module loader. numThreads is pinned to 1 (offscreen documents
  // are not cross-origin isolated), but the threaded binary is the only
  // WASM build onnxruntime-web ships.
  ["onnxruntime-web/dist/ort.wasm.bundle.min.mjs", "ort/ort.wasm.bundle.min.mjs"],
  ["onnxruntime-web/dist/ort-wasm-simd-threaded.wasm", "ort/ort-wasm-simd-threaded.wasm"],
  ["onnxruntime-web/dist/ort-wasm-simd-threaded.mjs", "ort/ort-wasm-simd-threaded.mjs"],
  // pdf.js: library + worker (text-layer extraction).
  ["pdfjs-dist/build/pdf.min.mjs", "pdfjs/pdf.min.mjs"],
  ["pdfjs-dist/build/pdf.worker.min.mjs", "pdfjs/pdf.worker.min.mjs"],
  // tesseract.js: API + worker script.
  ["tesseract.js/dist/tesseract.esm.min.js", "tesseract/tesseract.esm.min.js"],
  ["tesseract.js/dist/worker.min.js", "tesseract/worker.min.js"],
  // tesseract.js-core: the LSTM cores (plain / SIMD / relaxed SIMD). The
  // worker feature-detects and picks one; the .wasm.js files embed the
  // wasm binary. The legacy non-LSTM cores are not used (OEM is pinned
  // to LSTM-only) and are not vendored.
  ["tesseract.js-core/tesseract-core-lstm.js", "tesseract/tesseract-core-lstm.js"],
  ["tesseract.js-core/tesseract-core-lstm.wasm.js", "tesseract/tesseract-core-lstm.wasm.js"],
  ["tesseract.js-core/tesseract-core-simd-lstm.js", "tesseract/tesseract-core-simd-lstm.js"],
  ["tesseract.js-core/tesseract-core-simd-lstm.wasm.js", "tesseract/tesseract-core-simd-lstm.wasm.js"],
  ["tesseract.js-core/tesseract-core-relaxedsimd-lstm.js", "tesseract/tesseract-core-relaxedsimd-lstm.js"],
  ["tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js", "tesseract/tesseract-core-relaxedsimd-lstm.wasm.js"],
];

let total = 0;
for (const [src, dest] of FILES) {
  const to = out(dest);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(nm(src), to);
  const size = statSync(to).size;
  total += size;
  console.log(`${(size / 1024).toFixed(0).padStart(7)} KiB  vendor/${dest}`);
}
console.log(`total: ${(total / 1024 / 1024).toFixed(1)} MiB`);
