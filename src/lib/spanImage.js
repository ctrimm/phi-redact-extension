/**
 * Mapping between OCR words, assembled text, and detected entities.
 *
 * Pure functions, unit tested in Node. The offscreen document assembles
 * OCR output into one text with `assembleOcrText`, runs the redaction
 * pipeline over that text, and uses `boxesForEntities` to find which
 * word boxes to black out on the image.
 *
 * A "word" here is { text, bbox: {x0, y0, x1, y1} } in image pixel
 * coordinates, as produced by tesseract.js. Words are joined with a
 * single space; each word records the [start, end) char range it
 * occupies in the assembled text.
 */

/**
 * @param {Array<{text: string, bbox: object}>} words
 * @returns {{text: string, words: Array<{text, bbox, start, end}>}}
 */
export function assembleOcrText(words) {
  const kept = [];
  let text = "";
  for (const w of words ?? []) {
    const t = (w.text ?? "").trim();
    if (!t) continue;
    const start = text.length === 0 ? 0 : text.length + 1;
    if (text.length > 0) text += " ";
    text += t;
    kept.push({ text: t, bbox: w.bbox, start, end: start + t.length });
  }
  return { text, words: kept };
}

/**
 * Boxes to black out: every OCR word whose char range intersects an
 * entity span. Returned boxes are padded by `pad` px and clipped to the
 * image bounds when width/height are given.
 *
 * @param {Array} entities redaction entities with start/end
 * @param {Array} words assembled words (from assembleOcrText)
 * @param {{pad?: number, width?: number, height?: number}} opts
 */
export function boxesForEntities(entities, words, opts = {}) {
  const pad = opts.pad ?? 2;
  const boxes = [];
  for (const w of words ?? []) {
    const hit = (entities ?? []).some(
      (e) => e.start < w.end && w.start < e.end,
    );
    if (!hit || !w.bbox) continue;
    let { x0, y0, x1, y1 } = w.bbox;
    x0 = Math.max(0, x0 - pad);
    y0 = Math.max(0, y0 - pad);
    x1 = opts.width ? Math.min(opts.width, x1 + pad) : x1 + pad;
    y1 = opts.height ? Math.min(opts.height, y1 + pad) : y1 + pad;
    boxes.push({ x0, y0, x1, y1 });
  }
  return boxes;
}

/**
 * The text of an entity as the overlay should show it: a short snippet
 * of the surrounding text, for the review list.
 */
export function snippetFor(text, entity, radius = 24) {
  const s = Math.max(0, entity.start - radius);
  const e = Math.min(text.length, entity.end + radius);
  const pre = s > 0 ? "..." : "";
  const post = e < text.length ? "..." : "";
  return `${pre}${text.slice(s, e)}${post}`;
}
