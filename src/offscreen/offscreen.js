/**
 * phi-redact Upload Guard — offscreen document.
 *
 * Hosts everything heavy that must not run in a page or a service
 * worker:
 *   - model download + Cache Storage management (assets come from
 *     Hugging Face once; document data never leaves the browser)
 *   - the ONNX Runtime session for the phi-redact v9 INT8 model
 *   - pdf.js text-layer extraction (with an OCR fallback for scanned
 *     PDFs)
 *   - tesseract.js OCR for images, with word bounding boxes
 *
 * Speaks runtime messages shaped { target: "offscreen", type, ... }.
 */

import * as ort from "../../vendor/ort/ort.wasm.bundle.min.mjs";
import * as pdfjsLib from "../../vendor/pdfjs/pdf.min.mjs";
import { WordPieceTokenizer } from "../lib/tokenizer.js";
import { NeuralEngine } from "../lib/neural.js";
import { scanAll } from "../lib/merge.js";
import { assembleOcrText, boxesForEntities } from "../lib/spanImage.js";
import {
  MODEL_CACHE,
  MODEL_FILES,
  MODEL_TOTAL_BYTES,
  MODEL_VERSION,
  modelFileUrl,
} from "../lib/modelFiles.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
  "vendor/pdfjs/pdf.worker.min.mjs",
);

ort.env.wasm.wasmPaths = chrome.runtime.getURL("vendor/ort/");
ort.env.wasm.numThreads = 1; // offscreen documents are not cross-origin isolated

const OCR_PDF_MAX_PAGES = 5;

// ---------------------------------------------------------------------------
// Model management
// ---------------------------------------------------------------------------

const model = {
  state: "unknown", // unknown | missing | downloading | loading | ready | error
  downloadedBytes: 0,
  error: null,
  engine: null,
  enginePromise: null,
};

function modelStatus() {
  return {
    state: model.state,
    version: MODEL_VERSION,
    downloadedBytes: model.downloadedBytes,
    totalBytes: MODEL_TOTAL_BYTES,
    error: model.error,
  };
}

function broadcastStatus() {
  chrome.runtime
    .sendMessage({ target: "broadcast", type: "model-status", status: modelStatus() })
    .catch(() => {});
}

function setState(state, extra = {}) {
  Object.assign(model, extra, { state });
  broadcastStatus();
}

async function cacheHasAll() {
  const cache = await caches.open(MODEL_CACHE);
  for (const f of MODEL_FILES) {
    if (!(await cache.match(modelFileUrl(f.name)))) return false;
  }
  return true;
}

async function getAssetBuffer(file) {
  const cache = await caches.open(MODEL_CACHE);
  const hit = await cache.match(modelFileUrl(file.name));
  if (hit) return hit.arrayBuffer();
  const resp = await fetch(modelFileUrl(file.name));
  if (!resp.ok) throw new Error(`download failed for ${file.name}: HTTP ${resp.status}`);
  const buf = await resp.arrayBuffer();
  await cache.put(
    modelFileUrl(file.name),
    new Response(buf.slice(0), { headers: { "Content-Type": "application/octet-stream" } }),
  );
  return buf;
}

async function downloadModel() {
  if (model.state === "downloading" || model.state === "loading") return modelStatus();
  setState("downloading", { downloadedBytes: 0, error: null });
  try {
    const cache = await caches.open(MODEL_CACHE);
    let done = 0;
    for (const file of MODEL_FILES) {
      const url = modelFileUrl(file.name);
      if (await cache.match(url)) {
        done += file.bytes;
        setState("downloading", { downloadedBytes: done });
        continue;
      }
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`download failed for ${file.name}: HTTP ${resp.status}`);
      const reader = resp.body.getReader();
      const parts = [];
      let got = 0;
      for (;;) {
        const { done: fin, value } = await reader.read();
        if (fin) break;
        parts.push(value);
        got += value.byteLength;
        model.downloadedBytes = done + Math.min(got, file.bytes);
        broadcastStatus();
      }
      const buf = new Uint8Array(got);
      let at = 0;
      for (const p of parts) {
        buf.set(p, at);
        at += p.byteLength;
      }
      await cache.put(
        url,
        new Response(buf, { headers: { "Content-Type": "application/octet-stream" } }),
      );
      done += file.bytes;
      setState("downloading", { downloadedBytes: done });
    }
    await initEngine();
  } catch (err) {
    setState("error", { error: String(err?.message ?? err) });
  }
  return modelStatus();
}

async function initEngine() {
  if (model.engine?.ready) {
    setState("ready");
    return model.engine;
  }
  if (model.enginePromise) return model.enginePromise;
  model.enginePromise = (async () => {
    setState("loading", { error: null });
    const buffers = {};
    for (const file of MODEL_FILES) {
      buffers[file.key] = await getAssetBuffer(file);
    }
    const tokenizer = new WordPieceTokenizer(
      JSON.parse(new TextDecoder().decode(buffers.tokenizer)),
    );
    const labels = JSON.parse(new TextDecoder().decode(buffers.tags));
    const engine = new NeuralEngine(ort, tokenizer, labels);
    await engine.init(new Uint8Array(buffers.model));
    model.engine = engine;
    setState("ready");
    return engine;
  })();
  try {
    return await model.enginePromise;
  } finally {
    model.enginePromise = null;
  }
}

async function ensureEngine(autoDownload) {
  if (model.engine?.ready) return model.engine;
  if (await cacheHasAll()) return initEngine();
  if (!autoDownload) {
    const err = new Error("model not downloaded yet");
    err.code = "MODEL_MISSING";
    throw err;
  }
  await downloadModel();
  if (!model.engine?.ready) {
    const err = new Error(model.error ?? "model failed to load");
    err.code = "MODEL_ERROR";
    throw err;
  }
  return model.engine;
}

async function refreshState() {
  if (model.state === "unknown") {
    // Engine not loaded yet: report whether the assets are already
    // cached ("cached") or still need downloading ("missing").
    model.cached = await cacheHasAll();
    setState(model.cached ? "cached" : "missing");
  }
  return { ...modelStatus(), cached: model.cached ?? model.state === "ready" };
}

// ---------------------------------------------------------------------------
// OCR
// ---------------------------------------------------------------------------

let ocrWorker = null;

async function getOcrWorker() {
  if (ocrWorker) return ocrWorker;
  // The tesseract.js ESM bundle exposes its API on the default export.
  const { createWorker } = (
    await import("../../vendor/tesseract/tesseract.esm.min.js")
  ).default;
  ocrWorker = await createWorker("eng", 1 /* OEM.LSTM_ONLY */, {
    workerPath: chrome.runtime.getURL("vendor/tesseract/worker.min.js"),
    // Load the worker directly from its chrome-extension:// URL. With
    // the default (workerBlobURL: true) tesseract wraps it in a blob
    // worker whose opaque origin cannot importScripts extension files.
    workerBlobURL: false,
    corePath: chrome.runtime.getURL("vendor/tesseract/"),
    // English language data (~2 MB) is data, not code: fetched once
    // from the pinned jsDelivr copy of @tesseract.js-data/eng and then
    // cached by tesseract.js in IndexedDB.
    langPath: "https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0",
    gzip: true,
  });
  return ocrWorker;
}

function flattenWords(data) {
  const words = [];
  const push = (w) => {
    if (w && typeof w.text === "string" && w.bbox) {
      words.push({ text: w.text, bbox: w.bbox });
    }
  };
  if (Array.isArray(data?.words) && data.words.length > 0) {
    data.words.forEach(push);
  } else if (Array.isArray(data?.blocks)) {
    for (const b of data.blocks) {
      for (const p of b.paragraphs ?? []) {
        for (const l of p.lines ?? []) {
          for (const w of l.words ?? []) push(w);
        }
      }
    }
  }
  return words;
}

async function ocrImageBytes(bytes, mime) {
  const worker = await getOcrWorker();
  const blob = new Blob([bytes], { type: mime || "image/png" });
  const { data } = await worker.recognize(blob, {}, { blocks: true });
  return flattenWords(data);
}

// ---------------------------------------------------------------------------
// PDF extraction
// ---------------------------------------------------------------------------

async function extractPdf(bytes) {
  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  let text = "";
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (!("str" in item)) continue;
      text += item.str + (item.hasEOL ? "\n" : " ");
    }
    text += "\n";
  }
  if (text.replace(/\s/g, "").length >= 50) {
    return { kind: "pdf", text, viaOcr: false, pages: pdf.numPages };
  }
  // Scanned/image PDF: OCR the first pages and say so.
  const worker = await getOcrWorker();
  const pageCount = Math.min(pdf.numPages, OCR_PDF_MAX_PAGES);
  let combined = "";
  const pages = [];
  for (let p = 1; p <= pageCount; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;
    const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
    const { data } = await worker.recognize(blob, {}, { blocks: true });
    const assembled = assembleOcrText(flattenWords(data));
    const shift = combined.length === 0 ? 0 : combined.length + 1;
    if (combined.length > 0) combined += "\n";
    combined += assembled.text;
    pages.push({
      page: p,
      words: assembled.words.map((w) => ({
        ...w,
        start: w.start + shift,
        end: w.end + shift,
      })),
    });
  }
  return {
    kind: "pdf",
    text: combined,
    viaOcr: true,
    pages,
    truncatedPages: pdf.numPages > pageCount ? pdf.numPages - pageCount : 0,
  };
}

// ---------------------------------------------------------------------------
// Base64 helpers (message transport)
// ---------------------------------------------------------------------------

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Debug/testing hook: reachable only from extension contexts (this
// page is not web-accessible). Lets the manual test flow and CDP-driven
// checks exercise the engine without the message plumbing.
window.__phiRedact = {
  status: () => refreshState(),
  download: () => downloadModel(),
  scan: async (text, threshold = 0.6) => {
    const engine = await ensureEngine(true);
    const neural = await engine.predict(text, threshold);
    return scanAll(text, neural);
  },
  ocr: async (dataB64, mime) => {
    const words = await ocrImageBytes(b64ToBytes(dataB64), mime);
    return assembleOcrText(words);
  },
};

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== "offscreen") return;
  (async () => {
    try {
      switch (message.type) {
        case "model-status":
          sendResponse({ ok: true, status: await refreshState() });
          break;
        case "model-download":
          sendResponse({ ok: true, status: await downloadModel() });
          break;
        case "model-clear": {
          await caches.delete(MODEL_CACHE);
          model.engine = null;
          setState("missing", { downloadedBytes: 0 });
          sendResponse({ ok: true, status: { ...modelStatus(), cached: false } });
          break;
        }
        case "scan-text": {
          const engine = await ensureEngine(message.autoDownload !== false);
          const threshold = message.threshold ?? 0.6;
          const neural = await engine.predict(message.text ?? "", threshold);
          const result = scanAll(message.text ?? "", neural);
          sendResponse({
            ok: true,
            entities: result.entities,
            redacted: result.redacted,
            counts: result.counts,
            engine: result.engine,
          });
          break;
        }
        case "scan-rules-only": {
          // Used when the neural model is unavailable and the caller
          // still wants the deterministic layer's answer.
          const result = scanAll(message.text ?? "", []);
          sendResponse({
            ok: true,
            entities: result.entities,
            redacted: result.redacted,
            counts: result.counts,
            engine: result.engine,
          });
          break;
        }
        case "extract-pdf": {
          const out = await extractPdf(b64ToBytes(message.dataB64));
          sendResponse({ ok: true, ...out });
          break;
        }
        case "ocr-image": {
          const bytes = b64ToBytes(message.dataB64);
          const words = await ocrImageBytes(bytes, message.mime);
          const assembled = assembleOcrText(words);
          sendResponse({ ok: true, text: assembled.text, words: assembled.words });
          break;
        }
        case "image-boxes": {
          const boxes = boxesForEntities(message.entities ?? [], message.words ?? [], {
            pad: 2,
            width: message.width,
            height: message.height,
          });
          sendResponse({ ok: true, boxes });
          break;
        }
        default:
          sendResponse({ ok: false, error: `unknown type ${message.type}` });
      }
    } catch (err) {
      sendResponse({
        ok: false,
        error: String(err?.message ?? err),
        code: err?.code ?? "ERROR",
      });
    }
  })();
  return true; // async response
});
