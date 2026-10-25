/**
 * WordPiece tokenizer for the phi-redact model — a JavaScript port of the
 * Hugging Face `tokenizers` behavior for the shipped tokenizer.json
 * (BertNormalizer + BertPreTokenizer + WordPiece, BERT-uncased style).
 *
 * Written to match the reference implementation used by the phi-redact
 * SDK (ctrimm/phi-redact-sdk, python/phi_redact/engine.py), which encodes
 * with `tokenizers.Tokenizer.from_file(tokenizer.json)`:
 *   - clean_text: drop control chars / U+FFFD, normalize whitespace
 *   - handle_chinese_chars: pad CJK chars with spaces
 *   - lowercase + strip accents (strip_accents defaults to lowercase)
 *   - pre-tokenize: whitespace split, punctuation isolated
 *   - WordPiece greedy longest-match, "##" continuation prefix,
 *     max_input_chars_per_word = 100, unknown -> single [UNK]
 *   - offsets are character offsets into the ORIGINAL string, matching
 *     the Python bindings' Encoding.offsets semantics.
 *
 * Divergence note: offsets are tracked in UTF-16 code units (JS string
 * indices). For text outside the BMP (e.g. emoji) the Python engine's
 * offsets count Unicode code points instead, so spans after such a
 * character can differ by the surrogate count. Model inputs (ids) are
 * identical either way; only span bookkeeping after astral characters
 * is affected.
 */

const CJK_RANGES = [
  [0x4e00, 0x9fff],
  [0x3400, 0x4dbf],
  [0x20000, 0x2a6df],
  [0x2a700, 0x2b73f],
  [0x2b740, 0x2b81f],
  [0x2b820, 0x2ceaf],
  [0xf900, 0xfaff],
  [0x2f800, 0x2fa1f],
];

function isChineseChar(cp) {
  return CJK_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

function isWhitespace(ch) {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" ||
    ch === "\u000b" || ch === "\u000c" || /\p{Zs}/u.test(ch);
}

function isControl(ch) {
  if (ch === "\t" || ch === "\n" || ch === "\r") return false;
  const cp = ch.codePointAt(0);
  return cp < 0x20 || (cp >= 0x7f && cp < 0xa0);
}

function isPunctuation(ch) {
  const cp = ch.codePointAt(0);
  if (
    (cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) ||
    (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)
  ) {
    return true;
  }
  return /\p{P}/u.test(ch);
}

/**
 * Normalize one raw segment. Returns { chars, starts, ends } where
 * chars[i] is a normalized code point (string) and starts[i]/ends[i]
 * are its [start, end) span in the original segment (UTF-16 units,
 * relative to the segment start offset added by the caller).
 */
function normalizeSegment(text, cfg) {
  const chars = [];
  const starts = [];
  const ends = [];
  const push = (ch, s, e) => {
    chars.push(ch);
    starts.push(s);
    ends.push(e);
  };

  // Pass 1: clean text, whitespace, CJK spacing (tokenizers BertNormalizer
  // does these before lowercasing/stripping).
  const staged = []; // {ch, s, e} code points
  let idx = 0;
  for (const ch of text) {
    const s = idx;
    const e = idx + ch.length;
    idx = e;
    if (cfg.cleanText) {
      if (ch === "\u0000" || ch === "\ufffd" || isControl(ch)) continue;
      if (isWhitespace(ch)) {
        staged.push({ ch: " ", s, e });
        continue;
      }
    }
    if (cfg.handleChineseChars && isChineseChar(ch.codePointAt(0))) {
      staged.push({ ch: " ", s, e });
      staged.push({ ch, s, e });
      staged.push({ ch: " ", s, e });
      continue;
    }
    staged.push({ ch, s, e });
  }

  // Pass 2: lowercase, then strip accents per resulting code point.
  for (const { ch, s, e } of staged) {
    let c = ch;
    if (cfg.lowercase) c = c.toLowerCase();
    for (const cp of c) {
      if (cfg.stripAccents) {
        for (const part of cp.normalize("NFD")) {
          if (!/\p{Mn}/u.test(part)) push(part, s, e);
        }
      } else {
        push(cp, s, e);
      }
    }
  }
  return { chars, starts, ends };
}

/** Split normalized code points into pre-tokens (whitespace, punctuation). */
function preTokenize(norm) {
  const tokens = []; // {start,end} indices into norm arrays
  let i = 0;
  const n = norm.chars.length;
  while (i < n) {
    if (norm.chars[i] === " ") {
      i++;
      continue;
    }
    if (isPunctuation(norm.chars[i])) {
      tokens.push({ start: i, end: i + 1 });
      i++;
      continue;
    }
    let j = i;
    while (j < n && norm.chars[j] !== " " && !isPunctuation(norm.chars[j])) j++;
    tokens.push({ start: i, end: j });
    i = j;
  }
  return tokens;
}

export class WordPieceTokenizer {
  /**
   * @param {object} tokenizerJson parsed tokenizer.json from the model repo
   */
  constructor(tokenizerJson) {
    const norm = tokenizerJson.normalizer ?? {};
    const lowercase = norm.lowercase ?? false;
    this.cfg = {
      cleanText: norm.clean_text ?? true,
      handleChineseChars: norm.handle_chinese_chars ?? false,
      lowercase,
      // tokenizers: strip_accents null means "strip iff lowercase"
      stripAccents: norm.strip_accents ?? lowercase,
    };
    const model = tokenizerJson.model ?? {};
    this.vocab = model.vocab ?? {};
    this.unkToken = model.unk_token ?? "[UNK]";
    this.unkId = this.vocab[this.unkToken];
    this.prefix = model.continuing_subword_prefix ?? "##";
    this.maxCharsPerWord = model.max_input_chars_per_word ?? 100;
    this.addedTokens = new Map(); // content -> id
    for (const at of tokenizerJson.added_tokens ?? []) {
      this.addedTokens.set(at.content, at.id);
    }
    // Longest-first so overlapping added tokens match greedily.
    this.addedList = [...this.addedTokens.entries()].sort(
      (a, b) => b[0].length - a[0].length,
    );
    // Truncation: tokenizer.json enables it (Right, max_length 256,
    // LongestFirst). encode() applies it by default, exactly like
    // `tokenizers` — note this silently caps the SDK engine's neural
    // scan at 256 tokens, because its chunk-length check reads the
    // already-truncated count. The extension pipeline opts out via
    // { truncate: false } so long documents are chunked per the
    // engine's own _split design instead. See DECISION_LOG.md.
    const trunc = tokenizerJson.truncation;
    this.truncation =
      trunc && trunc.max_length ? { maxLength: trunc.max_length } : null;
    // Post-processor: the shipped tokenizer.json uses TemplateProcessing
    // "[CLS] A [SEP]". `tokenizers` applies it inside encode(), so the
    // ids returned already carry the specials (with [0, 0] offsets) —
    // and the SDK engine then adds [CLS]/[SEP] AGAIN around them. That
    // doubling is the shipped, measured behavior of the SDK (its golden
    // numbers were produced with it), so this port reproduces it
    // exactly rather than "fixing" it. See DECISION_LOG.md.
    this.postSpecials = null;
    const pp = tokenizerJson.post_processor;
    if (pp && pp.type === "TemplateProcessing" && Array.isArray(pp.single)) {
      const pre = pp.single[0]?.SpecialToken?.id;
      const post = pp.single[pp.single.length - 1]?.SpecialToken?.id;
      if (pre && post && this.vocab[pre] !== undefined && this.vocab[post] !== undefined) {
        this.postSpecials = [this.vocab[pre], this.vocab[post]];
      }
    }
  }

  tokenToId(token) {
    return this.vocab[token];
  }

  /** Special-token ids used by the engine: [CLS] / [SEP] if present. */
  specialIds() {
    const cls = this.tokenToId("[CLS]");
    const sep = this.tokenToId("[SEP]");
    if (cls !== undefined && sep !== undefined) return [cls, sep];
    return [0, 2]; // legacy BPE fallback, mirrors the Python engine
  }

  /**
   * Encode text, mirroring `tokenizers` encode() including its
   * post-processor: for the shipped tokenizer the returned ids are
   * [CLS] + tokens + [SEP], specials carrying [0, 0] offsets. (The SDK
   * engine adds a second [CLS]/[SEP] pair around this — see the note
   * in the constructor.)
   * @returns {{ids: number[], offsets: Array<[number, number]>}}
   * offsets are [start, end) character spans in the original string
   * (UTF-16 code units).
   */
  encode(text, opts = {}) {
    let body = this._encodeBody(text);
    const nSpecials = this.postSpecials ? this.postSpecials.length : 0;
    if (this.truncation && opts.truncate !== false) {
      const room = Math.max(0, this.truncation.maxLength - nSpecials);
      if (body.ids.length > room) {
        body = {
          ids: body.ids.slice(0, room),
          offsets: body.offsets.slice(0, room),
        };
      }
    }
    if (this.postSpecials) {
      const [pre, post] = this.postSpecials;
      return {
        ids: [pre, ...body.ids, post],
        offsets: [[0, 0], ...body.offsets, [0, 0]],
      };
    }
    return body;
  }

  _encodeBody(text) {
    const ids = [];
    const offsets = [];
    // Split out added (special) tokens first; they match literally on
    // the raw string and are never normalized, like the Rust tokenizer.
    const segments = []; // {text, base, specialId|null}
    let rest = text;
    let base = 0;
    while (rest.length > 0) {
      let hit = null;
      let hitAt = -1;
      for (const [content] of this.addedList) {
        const at = rest.indexOf(content);
        if (at !== -1 && (hitAt === -1 || at < hitAt)) {
          hit = content;
          hitAt = at;
        }
      }
      if (hit === null) {
        segments.push({ text: rest, base, specialId: null });
        break;
      }
      if (hitAt > 0) {
        segments.push({ text: rest.slice(0, hitAt), base, specialId: null });
      }
      segments.push({
        text: hit,
        base: base + hitAt,
        specialId: this.addedTokens.get(hit),
      });
      base += hitAt + hit.length;
      rest = rest.slice(hitAt + hit.length);
    }

    for (const seg of segments) {
      if (seg.specialId !== null) {
        ids.push(seg.specialId);
        offsets.push([seg.base, seg.base + seg.text.length]);
        continue;
      }
      const norm = normalizeSegment(seg.text, this.cfg);
      for (const tok of preTokenize(norm)) {
        this._wordPiece(norm, tok, seg.base, ids, offsets);
      }
    }
    return { ids, offsets };
  }

  _wordPiece(norm, tok, base, ids, offsets) {
    const wordChars = norm.chars.slice(tok.start, tok.end);
    if (wordChars.length > this.maxCharsPerWord) {
      ids.push(this.unkId);
      offsets.push([
        base + norm.starts[tok.start],
        base + norm.ends[tok.end - 1],
      ]);
      return;
    }
    let start = 0;
    const pieces = [];
    let bad = false;
    while (start < wordChars.length) {
      let end = wordChars.length;
      let found = null;
      while (start < end) {
        const piece =
          (start > 0 ? this.prefix : "") + wordChars.slice(start, end).join("");
        if (piece in this.vocab) {
          found = { id: this.vocab[piece], start, end };
          break;
        }
        end--;
      }
      if (found === null) {
        bad = true;
        break;
      }
      pieces.push(found);
      start = end;
    }
    if (bad) {
      ids.push(this.unkId);
      offsets.push([
        base + norm.starts[tok.start],
        base + norm.ends[tok.end - 1],
      ]);
      return;
    }
    for (const p of pieces) {
      ids.push(p.id);
      offsets.push([
        base + norm.starts[tok.start + p.start],
        base + norm.ends[tok.start + p.end - 1],
      ]);
    }
  }
}
