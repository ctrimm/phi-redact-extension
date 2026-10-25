/**
 * File-type routing for intercepted uploads.
 *
 * Pure functions (no DOM, no chrome APIs) so the routing table is unit
 * testable in Node. The content script and offscreen document both use
 * this to decide how a File gets its text extracted:
 *   "text"  -> read as text directly
 *   "pdf"   -> pdf.js text layer, OCR fallback for scanned pages
 *   "image" -> OCR (tesseract.js) with word bounding boxes
 *   "other" -> not scanned in v1 (the review UI says so, plainly)
 */

export const MAX_SCAN_BYTES = 25 * 1024 * 1024; // 25 MB per file in v1

const TEXT_EXTS = new Set(["txt", "md", "markdown", "csv", "tsv", "log", "text"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp"]);
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);

export function extOf(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(name ?? "");
  return m ? m[1].toLowerCase() : "";
}

/**
 * @param {{name?: string, type?: string, size?: number}} file
 * @returns {"text" | "pdf" | "image" | "other"}
 */
export function routeFile(file) {
  const ext = extOf(file?.name ?? "");
  const mime = (file?.type ?? "").toLowerCase();
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (IMAGE_MIMES.has(mime) || IMAGE_EXTS.has(ext)) return "image";
  if (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    TEXT_EXTS.has(ext)
  ) {
    return "text";
  }
  return "other";
}

/** True when the file is inside the v1 size envelope for scanning. */
export function withinScanSize(file) {
  return (file?.size ?? 0) <= MAX_SCAN_BYTES;
}

/**
 * Name for a redacted copy: insert ".redacted" before the extension
 * (photo.png -> photo.redacted.png, notes -> notes.redacted).
 */
export function redactedName(name, newExt) {
  const ext = extOf(name);
  if (newExt) {
    const stem = ext ? name.slice(0, -(ext.length + 1)) : name;
    return `${stem}.redacted.${newExt}`;
  }
  if (!ext) return `${name}.redacted`;
  return `${name.slice(0, -(ext.length + 1))}.redacted.${ext}`;
}
