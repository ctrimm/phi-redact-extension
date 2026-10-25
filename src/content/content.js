/**
 * phi-redact Upload Guard — content script.
 *
 * Installed on all pages/frames. Watches for the three ways a file
 * starts an upload — a file input changing, a drag-and-drop drop, and
 * a paste — at capture phase, holds the files, and has them scanned
 * locally by the extension's offscreen document (ONNX model + rules,
 * pdf.js, OCR). If anything is found (or a file could not be scanned),
 * a review overlay offers: upload redacted copies, upload the
 * originals anyway, or cancel.
 *
 * Privacy: file contents are read inside the page context and sent
 * only to the extension's own offscreen document via extension
 * messaging. Nothing is sent to any server by this script.
 *
 * The small pure helpers below (routeFile, redactedName,
 * boxesForEntities equivalents) mirror src/lib/ — content scripts are
 * classic scripts and cannot import the ES modules; the lib versions
 * are the canonical, unit-tested ones.
 */
(() => {
  "use strict";
  if (window.__phiRedactGuardInstalled) return;
  window.__phiRedactGuardInstalled = true;

  // --- mirrored pure helpers (canonical: src/lib/fileTypes.js) ------------
  const MAX_SCAN_BYTES = 25 * 1024 * 1024;
  const TEXT_EXTS = new Set(["txt", "md", "markdown", "csv", "tsv", "log", "text"]);
  const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp"]);
  const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
  const extOf = (name) => {
    const m = /\.([A-Za-z0-9]+)$/.exec(name ?? "");
    return m ? m[1].toLowerCase() : "";
  };
  function routeFile(file) {
    const ext = extOf(file?.name ?? "");
    const mime = (file?.type ?? "").toLowerCase();
    if (mime === "application/pdf" || ext === "pdf") return "pdf";
    if (IMAGE_MIMES.has(mime) || IMAGE_EXTS.has(ext)) return "image";
    if (mime.startsWith("text/") || mime === "application/json" || TEXT_EXTS.has(ext)) {
      return "text";
    }
    return "other";
  }
  function redactedName(name, newExt) {
    const ext = extOf(name);
    if (newExt) {
      const stem = ext ? name.slice(0, -(ext.length + 1)) : name;
      return `${stem}.redacted.${newExt}`;
    }
    if (!ext) return `${name}.redacted`;
    return `${name.slice(0, -(ext.length + 1))}.redacted.${ext}`;
  }

  // --- settings ------------------------------------------------------------
  let settings = {
    enabled: true,
    threshold: 0.6,
    autoDownloadModel: true,
    disabledSites: [],
  };
  const settingsReady = chrome.runtime
    .sendMessage({ target: "background", type: "get-settings" })
    .then((resp) => {
      if (resp?.ok) settings = { ...settings, ...resp.settings };
    })
    .catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes["phi-redact-settings"]?.newValue) {
      settings = { ...settings, ...changes["phi-redact-settings"].newValue };
    }
  });
  const siteDisabled = () =>
    (settings.disabledSites ?? []).includes(location.hostname);

  // --- messaging -------------------------------------------------------------
  async function toBackground(type, extra = {}) {
    return chrome.runtime.sendMessage({ target: "background", type, ...extra });
  }
  async function toOffscreen(type, extra = {}) {
    await toBackground("ensure-offscreen");
    return chrome.runtime.sendMessage({ target: "offscreen", type, ...extra });
  }

  function fileToB64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  // --- scanning ----------------------------------------------------------------
  /**
   * Scan one file. Returns a result object:
   * { file, kind, status: "clean"|"hits"|"partial"|"unscanned"|"error",
   *   entities, redacted, note, words?, viaOcr? }
   */
  async function scanFile(file) {
    const kind = routeFile(file);
    const base = { file, kind, entities: [], redacted: null, note: null };
    if (file.size > MAX_SCAN_BYTES) {
      return { ...base, status: "unscanned", note: "Larger than the 25 MB v1 scan limit." };
    }
    if (kind === "other") {
      return { ...base, status: "unscanned", note: "This file type is not scanned in v1." };
    }
    try {
      let text = "";
      let words = null;
      let viaOcr = false;
      let pdfPages = null;
      if (kind === "text") {
        text = await file.text();
      } else if (kind === "pdf") {
        const out = await toOffscreen("extract-pdf", { dataB64: await fileToB64(file) });
        if (!out?.ok) throw new Error(out?.error ?? "PDF extraction failed");
        text = out.text ?? "";
        viaOcr = !!out.viaOcr;
        pdfPages = out.pages ?? null;
      } else if (kind === "image") {
        const out = await toOffscreen("ocr-image", {
          dataB64: await fileToB64(file),
          mime: file.type,
        });
        if (!out?.ok) throw new Error(out?.error ?? "OCR failed");
        text = out.text ?? "";
        words = out.words ?? [];
      }

      let scan = await toOffscreen("scan-text", {
        text,
        threshold: settings.threshold,
        autoDownload: settings.autoDownloadModel !== false,
      });
      let modelMissing = false;
      if (!scan?.ok && scan?.code === "MODEL_MISSING") {
        modelMissing = true;
        scan = await toOffscreen("scan-rules-only", { text });
      }
      if (!scan?.ok) throw new Error(scan?.error ?? "scan failed");

      const entities = scan.entities ?? [];
      const status =
        entities.length > 0 ? "hits" : modelMissing ? "partial" : "clean";
      return {
        ...base,
        status,
        entities,
        redacted: scan.redacted ?? null,
        words,
        viaOcr,
        pdfPages,
        note: modelMissing
          ? "Scanned with the rules layer only — the neural model is not downloaded yet, so names and free-text PHI may have been missed."
          : viaOcr
            ? "Text came from OCR, which can misread characters; review detections with that in mind."
            : null,
      };
    } catch (err) {
      return { ...base, status: "error", note: String(err?.message ?? err) };
    }
  }

  // --- redacted artifacts -------------------------------------------------------
  async function buildRedactedFile(result) {
    const { file, kind } = result;
    if (kind === "text" || kind === "pdf") {
      if (result.redacted == null) return null;
      const name =
        kind === "pdf" ? redactedName(file.name, "txt") : redactedName(file.name);
      return new File([result.redacted], name, { type: "text/plain" });
    }
    if (kind === "image") {
      const bitmap = await createImageBitmap(file);
      const out = await toOffscreen("image-boxes", {
        entities: result.entities,
        words: result.words ?? [],
        width: bitmap.width,
        height: bitmap.height,
      });
      const boxes = out?.ok ? out.boxes : [];
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      ctx.fillStyle = "#000";
      for (const b of boxes) ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
      const mime = IMAGE_MIMES.has(file.type) ? file.type : "image/png";
      const blob = await new Promise((res) => canvas.toBlob(res, mime, 0.92));
      if (!blob) return null;
      return new File([blob], redactedName(file.name), { type: mime });
    }
    return null;
  }

  function downloadFile(f) {
    const url = URL.createObjectURL(f);
    const a = document.createElement("a");
    a.href = url;
    a.download = f.name;
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // --- overlay -------------------------------------------------------------------
  const OVERLAY_CSS = `
    :host { all: initial; }
    .backdrop { position: fixed; inset: 0; background: rgba(12, 14, 18, 0.55);
      z-index: 2147483647; display: flex; align-items: center; justify-content: center;
      font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    .panel { background: #fff; color: #16181d; border-radius: 12px; max-width: 620px;
      width: calc(100vw - 48px); max-height: 84vh; overflow: auto; padding: 20px 22px;
      box-shadow: 0 18px 50px rgba(0,0,0,0.35); }
    h2 { font-size: 17px; margin: 0 0 4px; }
    .sub { font-size: 13px; color: #4b5563; margin: 0 0 14px; line-height: 1.45; }
    .file { border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 12px; margin: 0 0 10px; }
    .fname { font-weight: 600; font-size: 13.5px; word-break: break-all; }
    .fmeta { font-size: 12px; color: #6b7280; margin-top: 2px; }
    .note { font-size: 12px; color: #92400e; margin-top: 6px; line-height: 1.4; }
    .ents { margin: 8px 0 0; padding: 0; list-style: none; }
    .ents li { font-size: 12.5px; padding: 3px 0; display: flex; gap: 8px; align-items: baseline; }
    .chip { background: #111827; color: #fff; border-radius: 4px; padding: 1px 6px;
      font-size: 10.5px; font-weight: 700; letter-spacing: 0.02em; white-space: nowrap; }
    .etext { word-break: break-all; }
    .score { color: #6b7280; font-size: 11px; }
    .dl { margin-top: 8px; font-size: 12px; }
    .dl button { background: none; border: none; color: #1d4ed8; cursor: pointer;
      padding: 0; font-size: 12px; text-decoration: underline; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
    .actions button { border-radius: 8px; padding: 9px 14px; font-size: 13.5px;
      cursor: pointer; border: 1px solid #d1d5db; background: #f9fafb; color: #111827; }
    .actions button.primary { background: #111827; color: #fff; border-color: #111827; }
    .actions button:disabled { opacity: 0.45; cursor: default; }
    .foot { font-size: 11.5px; color: #6b7280; margin-top: 12px; line-height: 1.45; }
    .spinner { font-size: 14px; }
  `;

  function showOverlay(build) {
    const host = document.createElement("div");
    host.id = "phi-redact-overlay";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = OVERLAY_CSS;
    const backdrop = document.createElement("div");
    backdrop.className = "backdrop";
    const panel = document.createElement("div");
    panel.className = "panel";
    backdrop.appendChild(panel);
    shadow.append(style, backdrop);
    document.documentElement.appendChild(host);
    const close = () => host.remove();
    build(panel, close);
    return { host, close };
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function showScanning(token) {
    return showOverlay((panel) => {
      const h = el("h2", null, "phi-redact is scanning your upload");
      const p = el("p", "sub",
        "Checking locally, in your browser. The upload is paused until the scan finishes.");
      const spin = el("p", "spinner", "Scanning...");
      const actions = el("div", "actions");
      const cancel = el("button", null, "Cancel upload");
      cancel.addEventListener("click", () => {
        token.cancelled = true;
      });
      actions.appendChild(cancel);
      panel.append(h, p, spin, actions);
    });
  }

  function showReview(results, decide) {
    return showOverlay((panel, close) => {
      const totalHits = results.reduce((a, r) => a + r.entities.length, 0);
      panel.appendChild(el("h2", null,
        totalHits > 0
          ? `phi-redact found ${totalHits} possible identifier${totalHits === 1 ? "" : "s"}`
          : "phi-redact could not fully scan this upload"));
      panel.appendChild(el("p", "sub",
        "The upload is paused. Review what was detected, then choose how to proceed. " +
        "Redacted copies replace each identifier with a placeholder like [NAME_PATIENT_1]."));

      for (const r of results) {
        const box = el("div", "file");
        box.appendChild(el("div", "fname", r.file.name));
        const meta = el("div", "fmeta",
          r.status === "hits"
            ? `${r.entities.length} detection${r.entities.length === 1 ? "" : "s"}`
            : r.status === "clean"
              ? "Scanned — nothing found"
              : r.status === "partial"
                ? "Partially scanned"
                : r.status === "error"
                  ? "Scan failed"
                  : "Not scanned");
        box.appendChild(meta);
        if (r.entities.length > 0) {
          const ul = el("ul", "ents");
          for (const e of r.entities.slice(0, 25)) {
            const li = document.createElement("li");
            li.appendChild(el("span", "chip", e.label));
            li.appendChild(el("span", "etext", e.text));
            if (typeof e.score === "number") {
              li.appendChild(el("span", "score",
                `${Math.round(e.score * 100)}% · ${e.source}`));
            } else {
              li.appendChild(el("span", "score", e.source));
            }
            ul.appendChild(li);
          }
          if (r.entities.length > 25) {
            const li = document.createElement("li");
            li.appendChild(el("span", "score",
              `... and ${r.entities.length - 25} more`));
            ul.appendChild(li);
          }
          box.appendChild(ul);
        }
        if (r.note) box.appendChild(el("div", "note", r.note));
        if (r.status === "hits") {
          const dl = el("div", "dl");
          const btn = el("button", null, "Download redacted copy");
          btn.addEventListener("click", async () => {
            btn.disabled = true;
            btn.textContent = "Preparing...";
            const f = await buildRedactedFile(r);
            if (f) downloadFile(f);
            btn.disabled = false;
            btn.textContent = "Download redacted copy";
          });
          dl.appendChild(btn);
          box.appendChild(dl);
        }
        panel.appendChild(box);
      }

      const excluded = results.filter(
        (r) => r.status === "unscanned" || r.status === "error",
      );
      const actions = el("div", "actions");
      const btnRedacted = el("button", "primary", "Upload redacted copies");
      const btnOriginal = el("button", null, "Upload originals anyway");
      const btnCancel = el("button", null, "Cancel upload");
      if (excluded.length > 0) {
        panel.appendChild(el("div", "note",
          `Files that could not be scanned (${excluded.map((r) => r.file.name).join(", ")}) ` +
          "are left out of a redacted upload. Use \u201CUpload originals anyway\u201D to include them unmodified."));
      }
      btnRedacted.addEventListener("click", async () => {
        btnRedacted.disabled = true;
        btnOriginal.disabled = true;
        btnRedacted.textContent = "Preparing redacted copies...";
        const files = [];
        for (const r of results) {
          if (r.status === "hits") {
            const f = await buildRedactedFile(r);
            if (f) files.push(f);
          } else if (r.status === "clean" || r.status === "partial") {
            files.push(r.file);
          }
        }
        close();
        decide({ action: "redacted", files });
      });
      btnOriginal.addEventListener("click", () => {
        close();
        decide({ action: "original", files: results.map((r) => r.file) });
      });
      btnCancel.addEventListener("click", () => {
        close();
        decide({ action: "cancel", files: [] });
      });
      actions.append(btnRedacted, btnOriginal, btnCancel);
      panel.appendChild(actions);
      panel.appendChild(el("p", "foot",
        "phi-redact scans on this device only. The model was downloaded once from Hugging Face; " +
        "your files and their contents are never sent anywhere by this extension."));
    });
  }

  // --- release ---------------------------------------------------------------------
  const bypass = new WeakSet();

  function release(ctx, files) {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    if (ctx.kind === "input") {
      try {
        ctx.input.files = dt.files;
      } catch {
        return false;
      }
      const evIn = new Event("input", { bubbles: true });
      const evCh = new Event("change", { bubbles: true });
      bypass.add(evIn);
      bypass.add(evCh);
      ctx.input.dispatchEvent(evIn);
      ctx.input.dispatchEvent(evCh);
      return true;
    }
    if (ctx.kind === "drop") {
      const ev = new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
      });
      bypass.add(ev);
      (ctx.target ?? document).dispatchEvent(ev);
      return true;
    }
    if (ctx.kind === "paste") {
      const ev = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      });
      bypass.add(ev);
      (ctx.target ?? document).dispatchEvent(ev);
      return true;
    }
    return false;
  }

  function cancelCtx(ctx) {
    if (ctx.kind === "input") {
      try {
        ctx.input.value = "";
      } catch {
        /* some frameworks guard the setter; nothing more to do */
      }
    }
  }

  // --- interception ------------------------------------------------------------------
  async function handleIntercept(ctx, files) {
    const token = { cancelled: false };
    const scanning = showScanning(token);
    const results = [];
    for (const file of files) {
      if (token.cancelled) break;
      results.push(await scanFile(file));
    }
    scanning.close();
    if (token.cancelled) {
      cancelCtx(ctx);
      return;
    }
    const anyAttention = results.some((r) => r.status !== "clean");
    if (!anyAttention) {
      release(ctx, files);
      return;
    }
    showReview(results, ({ action, files: chosen }) => {
      if (action === "cancel") {
        cancelCtx(ctx);
        return;
      }
      const ok = release(ctx, chosen);
      if (!ok) {
        // The site would not accept a programmatic file assignment.
        // Fall back honestly: tell the user and hand them the files.
        showOverlay((panel, close) => {
          panel.appendChild(el("h2", null, "This site manages its own uploads"));
          panel.appendChild(el("p", "sub",
            "phi-redact could not hand the files back to this page automatically. " +
            "Download the copies you want and attach them with the site's own controls."));
          const actions = el("div", "actions");
          const dlAll = el("button", "primary", "Download the chosen files");
          dlAll.addEventListener("click", () => {
            for (const f of chosen) downloadFile(f);
            close();
          });
          const done = el("button", null, "Close");
          done.addEventListener("click", close);
          actions.append(dlAll, done);
          panel.appendChild(actions);
        });
      }
    });
  }

  function begin(event, ctx, files) {
    if (bypass.has(event)) return;
    if (!settings.enabled || siteDisabled()) return;
    if (!files || files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const snapshot = [...files];
    settingsReady.then(() => handleIntercept(ctx, snapshot));
  }

  window.addEventListener(
    "change",
    (e) => {
      const t = e.target;
      if (t instanceof HTMLInputElement && t.type === "file" && t.files?.length) {
        begin(e, { kind: "input", input: t }, t.files);
      }
    },
    true,
  );
  window.addEventListener(
    "drop",
    (e) => {
      if (e.dataTransfer?.files?.length) {
        begin(e, { kind: "drop", target: e.target }, e.dataTransfer.files);
      }
    },
    true,
  );
  window.addEventListener(
    "paste",
    (e) => {
      if (e.clipboardData?.files?.length) {
        begin(e, { kind: "paste", target: e.target }, e.clipboardData.files);
      }
    },
    true,
  );
})();
