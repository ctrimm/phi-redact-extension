/**
 * The model assets the extension downloads once from Hugging Face and
 * caches locally. Model weights are never committed to this repository.
 *
 * Repo: CDT5058/phi-redact (public), release v9.
 *   phi-redact-v9-int8.onnx  11,323,243 bytes  INT8-quantized model
 *   tokenizer.json              711,494 bytes  WordPiece tokenizer
 *   tags.json                     1,623 bytes  129 BIOES labels,
 *                                              index = label id
 * tags.json order was verified identical to config.json's id2label.
 */

export const MODEL_REPO = "CDT5058/phi-redact";
export const MODEL_REVISION = "main";
export const MODEL_VERSION = "v9";

export const MODEL_FILES = [
  { name: "phi-redact-v9-int8.onnx", bytes: 11323243, key: "model" },
  { name: "tokenizer.json", bytes: 711494, key: "tokenizer" },
  { name: "tags.json", bytes: 1623, key: "tags" },
];

export const MODEL_TOTAL_BYTES = MODEL_FILES.reduce((a, f) => a + f.bytes, 0);

export function modelFileUrl(name) {
  return `https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REVISION}/${name}`;
}

/** Cache Storage bucket for the downloaded model assets. */
export const MODEL_CACHE = "phi-redact-model-v9";
