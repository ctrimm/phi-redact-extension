/**
 * Merge + placeholder layer for phi-redact.
 *
 * Ported from the phi-redact SDK (ctrimm/phi-redact-sdk,
 * typescript/src/engine.ts, Apache-2.0) with types stripped; behavior is
 * unchanged.
 *
 * Merge policy: rules win every overlap with a neural span; neural-neural
 * overlaps keep the higher score. Placeholders are numbered per label in
 * forward document order: [NAME_PATIENT_1], [PHONE_2], ...
 */

import { restoreText, scan as rulesScan } from "./rules.js";

const overlaps = (a, b) => !(a.end <= b.start || a.start >= b.end);

/**
 * Rules win every overlap. Neural-neural overlaps keep the best score.
 * Returns entities sorted by start.
 */
export function mergeEntities(ruleEnts, neuralEnts = []) {
  const kept = [];
  for (const n of [...neuralEnts].sort(
    (a, b) => (b.score ?? 0) - (a.score ?? 0),
  )) {
    if (ruleEnts.some((r) => overlaps(n, r))) continue;
    if (kept.some((k) => overlaps(n, k))) continue;
    kept.push(n);
  }
  return [...ruleEnts, ...kept].sort((a, b) => a.start - b.start);
}

/**
 * Replace back-to-front with temp tokens, then renumber per label in
 * forward document order: [NAME_PATIENT_1], [PHONE_2], ...
 */
export function applyPlaceholders(text, entities) {
  const temps = new Map();
  let out = text;
  const staging = {};

  [...entities]
    .sort((a, b) => b.start - a.start)
    .forEach((e, i) => {
      const tmp = `[\u0000${i}]`;
      temps.set(e, tmp);
      staging[tmp] = e.text;
      out = out.slice(0, e.start) + tmp + out.slice(e.end);
    });

  const counters = {};
  const mapping = {};
  for (const e of [...entities].sort((a, b) => a.start - b.start)) {
    counters[e.label] = (counters[e.label] ?? 0) + 1;
    const ph = `[${e.label}_${counters[e.label]}]`;
    e.placeholder = ph;
    mapping[ph] = staging[temps.get(e)];
    out = out.split(temps.get(e)).join(ph);
  }
  return { redacted: out, mapping };
}

/**
 * Full scan: rules + (optional) neural entities, merged, with the
 * redacted text and counts — the SDK's RedactionResult shape.
 *
 * @param {string} text
 * @param {Array} neuralEnts entities from the neural engine (may be [])
 * @returns {{redacted: string, entities: Array, mapping: object,
 *   counts: object, engine: string}}
 */
export function scanAll(text, neuralEnts = []) {
  const entities = mergeEntities(rulesScan(text), neuralEnts);
  const { redacted, mapping } = applyPlaceholders(text, entities);
  const counts = {};
  for (const e of entities) counts[e.label] = (counts[e.label] ?? 0) + 1;
  return {
    redacted,
    entities,
    mapping,
    counts,
    engine: neuralEnts.length > 0 ? "rules+onnx" : "rules",
  };
}

/** Put real values back using a mapping from scanAll(). */
export function restore(redacted, mapping) {
  return restoreText(redacted, mapping);
}
