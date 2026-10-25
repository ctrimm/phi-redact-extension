/**
 * Neural engine: ONNX Runtime wrapper around the phi-redact model.
 *
 * Mirrors the SDK Python engine's feed contract (engine.py OnnxEngine):
 *   ids  = [CLS] + token ids + [SEP]
 *   feed = exactly the inputs the graph declares (this graph declares
 *          input_ids, attention_mask, token_type_ids), all int64
 *   out  = "logits" -> softmax -> argmax -> BIOES decode
 *
 * The `ort` module is injected so the same code runs in the offscreen
 * document (onnxruntime-web from vendor/) and in Node integration tests.
 */

import { predictEntities, DEFAULT_MAX_LEN, DEFAULT_THRESHOLD } from "./bioes.js";

export class NeuralEngine {
  /**
   * @param {object} ort onnxruntime module (InferenceSession, Tensor)
   * @param {import("./tokenizer.js").WordPieceTokenizer} tokenizer
   * @param {string[]} labels tags.json contents (index = label id)
   */
  constructor(ort, tokenizer, labels) {
    this.ort = ort;
    this.tokenizer = tokenizer;
    this.labels = labels;
    this.session = null;
    this.inputNames = [];
    this.maxLen = DEFAULT_MAX_LEN;
    this.threshold = DEFAULT_THRESHOLD;
  }

  /** @param {ArrayBuffer | Uint8Array} modelBytes the .onnx model */
  async init(modelBytes) {
    this.session = await this.ort.InferenceSession.create(modelBytes, {
      executionProviders: ["wasm"],
    });
    this.inputNames = this.session.inputNames;
    return this;
  }

  get ready() {
    return this.session !== null;
  }

  async _runLogits(ids) {
    const seq = ids.length;
    const big = (arr) => BigInt64Array.from(arr, (x) => BigInt(x));
    const candidates = {
      input_ids: new this.ort.Tensor("int64", big(ids), [1, seq]),
      attention_mask: new this.ort.Tensor(
        "int64",
        big(new Array(seq).fill(1)),
        [1, seq],
      ),
      token_type_ids: new this.ort.Tensor(
        "int64",
        big(new Array(seq).fill(0)),
        [1, seq],
      ),
    };
    const feed = {};
    for (const name of this.inputNames) {
      if (candidates[name]) feed[name] = candidates[name];
    }
    const out = await this.session.run(feed);
    const logits = out.logits ?? out[this.session.outputNames[0]];
    return logits;
  }

  /** Neural entities for a text (rules are merged by the caller). */
  async predict(text, threshold = this.threshold) {
    if (!this.session) throw new Error("neural engine not initialized");
    return predictEntities(
      text,
      this.tokenizer,
      (ids) => this._runLogits(ids),
      this.labels,
      { maxLen: this.maxLen, threshold },
    );
  }
}
