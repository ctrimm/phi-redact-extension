/**
 * BIOES span decoding + long-text chunking for the phi-redact model.
 *
 * Direct port of the inference logic in the phi-redact SDK's Python
 * engine (ctrimm/phi-redact-sdk, python/phi_redact/engine.py):
 *   - texts longer than max_len tokens are split recursively near the
 *     midpoint at whitespace, with a 96-character overlap between the
 *     right-hand chunk and the cut point
 *   - per-token softmax + argmax; BIOES tags decoded leniently
 *     (malformed I-/E- transitions start a new span, as in the SDK)
 *   - a span's score is the mean of its tokens' predicted-label
 *     probabilities (the single-token probability for S- spans)
 *   - spans scoring below the threshold are dropped; duplicate spans
 *     produced by chunk overlap are deduped keeping the best score
 */

export const DEFAULT_MAX_LEN = 384; // tokens per ONNX chunk (incl. specials)
export const DEFAULT_THRESHOLD = 0.6; // min mean-token confidence (SDK 0.3.0)
export const OVERLAP_CHARS = 96;

/**
 * Split text into chunks the tokenizer encodes to <= maxLen - 2 tokens.
 * Mirrors OnnxEngine._split: returns [{text, offset}] with `offset` the
 * chunk's character position in the original text.
 */
export function splitText(text, tokenCount, maxLen = DEFAULT_MAX_LEN) {
  const out = [];
  const rec = (t, off) => {
    if (tokenCount(t) <= maxLen - 2) {
      out.push({ text: t, offset: off });
      return;
    }
    const mid = Math.floor(t.length / 2);
    let cut = mid;
    let found = false;
    for (let i = 1; i < Math.floor(t.length / 2) && !found; i++) {
      for (const j of [mid + i, mid - i]) {
        if (j > 0 && j < t.length && (t[j] === " " || t[j] === "\t" || t[j] === "\n")) {
          cut = j;
          found = true;
          break;
        }
      }
    }
    rec(t.slice(0, cut), off);
    const back = Math.max(0, cut - OVERLAP_CHARS);
    rec(t.slice(back), off + back);
  };
  rec(text, 0);
  return out;
}

function trimSpan(text, s, e) {
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  return [s, e];
}

/**
 * Decode one chunk's predictions into entities.
 * @param {string} fullText the ORIGINAL full text (spans index into it;
 *   offsets passed in are already absolute)
 * @param {Array<[number, number]>} offs token offsets including the
 *   leading/trailing [0, 0] sentinel entries for [CLS]/[SEP]
 * @param {ArrayLike<number>} pred predicted label id per position
 * @param {ArrayLike<number>} conf predicted-label probability per position
 * @param {string[]} id2label label per id (tags.json order)
 */
export function decodeChunk(fullText, offs, pred, conf, id2label) {
  const entities = [];
  let cur = null; // [label, start, end, confs[]]

  const flush = () => {
    if (cur === null) return;
    const [label, s0, e0, confs] = cur;
    cur = null;
    const [s, e] = trimSpan(fullText, s0, e0);
    if (s < e) {
      entities.push({
        start: s,
        end: e,
        label,
        text: fullText.slice(s, e),
        source: "neural",
        score: Math.round((confs.reduce((a, b) => a + b, 0) / confs.length) * 10000) / 10000,
      });
    }
  };

  for (let i = 0; i < offs.length; i++) {
    const [s, e] = offs[i];
    if (s === 0 && e === 0) {
      flush(); // special token
      continue;
    }
    const tag = id2label[pred[i]] ?? "O";
    if (tag === "O") {
      flush();
      continue;
    }
    const dash = tag.indexOf("-");
    const prefix = dash === -1 ? tag : tag.slice(0, dash);
    const typ = dash === -1 ? tag : tag.slice(dash + 1);
    const c = conf[i];
    if (prefix === "S") {
      flush();
      const [s2, e2] = trimSpan(fullText, s, e);
      if (s2 < e2) {
        entities.push({
          start: s2,
          end: e2,
          label: typ,
          text: fullText.slice(s2, e2),
          source: "neural",
          score: Math.round(c * 10000) / 10000,
        });
      }
    } else if (prefix === "B") {
      flush();
      cur = [typ, s, e, [c]];
    } else {
      // I / E, lenient on malformed transitions (same as the SDK)
      if (cur !== null && cur[0] === typ) {
        cur[2] = e;
        cur[3].push(c);
      } else {
        cur = [typ, s, e, [c]];
      }
      if (prefix === "E") flush();
    }
  }
  flush();
  return entities;
}

/** Numerically stable softmax over one row of logits. */
export function softmaxRow(logits, offset, n) {
  let max = -Infinity;
  for (let i = 0; i < n; i++) if (logits[offset + i] > max) max = logits[offset + i];
  const out = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    out[i] = Math.exp(logits[offset + i] - max);
    sum += out[i];
  }
  for (let i = 0; i < n; i++) out[i] /= sum;
  return out;
}

/**
 * Run the full neural prediction over a text.
 * @param {string} text
 * @param {{encode: (t: string) => {ids: number[], offsets: Array<[number,number]>}, specialIds: () => [number, number]}} tokenizer
 * @param {(ids: number[]) => Promise<{data: ArrayLike<number>, dims: number[]}>} runLogits
 *   runs the ONNX session for one chunk's token ids (specials included)
 *   and resolves with the logits tensor.
 * @param {string[]} labels tags.json order
 * @param {{maxLen?: number, threshold?: number}} opts
 * @returns {Promise<Array>} neural entities, threshold-filtered, deduped
 */
export async function predictEntities(text, tokenizer, runLogits, labels, opts = {}) {
  const maxLen = opts.maxLen ?? DEFAULT_MAX_LEN;
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const [bosId, eosId] = tokenizer.specialIds();
  // Deliberate divergence from the SDK engine's effective behavior:
  // tokenizer.json enables 256-token truncation, which silently caps
  // the SDK's neural scan (its _split length check reads the truncated
  // count, so chunking never engages). An upload scanner must not stop
  // looking for PII a page into a long document, so this port encodes
  // with truncation disabled and lets _split chunk at maxLen as
  // designed. Texts under the truncation limit behave identically.
  const encodeFull = (t) =>
    typeof tokenizer.encode === "function"
      ? tokenizer.encode(t, { truncate: false })
      : tokenizer.encode(t);
  const tokenCount = (t) => encodeFull(t).ids.length;
  const chunks = splitText(text, tokenCount, maxLen);
  const all = [];
  for (const chunk of chunks) {
    const enc = encodeFull(chunk.text);
    const ids = [bosId, ...enc.ids, eosId];
    const offs = [
      [0, 0],
      ...enc.offsets.map(([s, e]) => [s + chunk.offset, e + chunk.offset]),
      [0, 0],
    ];
    const logits = await runLogits(ids);
    const nLabels = labels.length;
    const seqLen = ids.length;
    const pred = new Array(seqLen);
    const conf = new Array(seqLen);
    for (let i = 0; i < seqLen; i++) {
      const probs = softmaxRow(logits.data, i * nLabels, nLabels);
      let best = 0;
      for (let j = 1; j < nLabels; j++) if (probs[j] > probs[best]) best = j;
      pred[i] = best;
      conf[i] = probs[best];
    }
    all.push(...decodeChunk(text, offs, pred, conf, labels));
  }
  // Dedupe identical spans produced by chunk overlap, keep best score —
  // then apply the threshold, exactly as the SDK engine does.
  const best = new Map();
  for (const e of all) {
    const key = `${e.start}|${e.end}|${e.label}`;
    if (!best.has(key) || e.score > best.get(key).score) best.set(key, e);
  }
  return [...best.values()]
    .filter((e) => e.score >= threshold)
    .sort((a, b) => a.start - b.start);
}
