# Decision Log

Data-backed decisions for this repo. New entries on top.

## 2026-10-27 — SDK 0.4.0/0.5.0 features in the UI: operators, lists, recognizers, thresholds, review mode

**Engine ported forward.** `src/lib/merge.js` is now a full port of
the SDK's TypeScript engine at 0.4.0 + 0.5.0 (the 0.5.0 API shapes
were taken from the SDK tree as that build landed: `Recognizer`,
`thresholds`, `reviewMargin`, `result.review`). It replaces the
0.3.0-era merge/placeholder layer: anonymize operators (numbered /
label / mask / hash / remove, salted SHA-256 construction identical
to the SDK, pinned by the shared test vectors), allow/deny lists,
custom recognizers (patterns, context boost, named validators;
precedence rules > recognizers > neural), per-label thresholds, and
the score gate with needs-review partitioning. The SDK's batch,
scrub, and ChunkedRestorer APIs were not ported — the extension has
no batch or LLM round-trip surface. Under default settings the new
engine's output is byte-for-byte the old output (unit-tested).

**The user threshold is the score gate.** The SDK's TS engine
hardcodes its global gate at DEFAULT_THRESHOLD in partitionByScore
because its neural layer gates server-side. Here the gate has to be
the extension's user-facing threshold, so `scanAll` takes it as
`options.threshold`, and the offscreen document now runs the neural
engine ungated (threshold 0) and lets the gate apply effective
thresholds. At the default 0.6 the kept set is unchanged; this is
also the only way review candidates can exist — a span the model
scored at 0.55 was previously discarded inside predict() before any
UI could ever see it.

**Review bucket semantics.** Candidates are pending by default and
are NOT redacted (SDK semantics: not in entities, not counted, not
in the mapping). Promoting one re-renders the file's redacted text
through the offscreen document (`apply-placeholders` message) so
numbering follows document order, and image black-boxes are computed
from the final entity set. Files whose only findings are borderline
now pause the upload (new "review" status) instead of passing as
clean. With review mode off, scans return an empty review list and
the overlay renders exactly as before (verified in Chrome).

**Settings flow.** All scan paths (file input, drop, paste — and the
rules-only fallback) build one options object from chrome.storage in
the content script and carry it on every scan message. The offscreen
document defensively drops stored recognizers that fail validation,
so a corrupt entry can never break scanning; the options page
validates with the same `checkRecognizer` and refuses to save invalid
recognizers, showing the error inline.

**Bug found by E2E: settings write race.** The background's
setSettings did an unserialized read-modify-write; the options page
saving several sections in quick succession (as the new, denser page
does) could lose patches — review settings silently reverted while
lists and recognizers saved. Writes are now serialized through a
promise chain in the service worker.

**Verification.** Unit 72/72 (38 pre-existing + 34 new in
test/features.test.js: operators incl. the SDK's pinned hash
vectors, lists, recognizers, thresholds, review band edges).
Integration parity vs the SDK Python engine passes with the real v9
model. A CDP-driven pass in the sandbox Chrome (26 checks) covered:
options-page persistence for every new setting; an upload whose
overlay showed 5 detections plus the Borderline bucket (recognizer
span at 50%); promoting the candidate and releasing — the page
received a copy with [EMPLOYEE_ID_1], [CUSTOM_1], [SSN_1] and no raw
identifiers; and the review-off path releasing originals untouched
with no bucket rendered. Screenshots: screenshots/options.png,
screenshots/overlay-review.png. Version 1.0.0 -> 1.1.0.

## 2026-10-24 — v1 scope and architecture

**Host the engine in an MV3 offscreen document.**
The background service worker cannot reliably run WASM/worker-heavy
workloads, and content scripts inherit page-adjacent constraints. One
offscreen document (reason: WORKERS) hosts the ONNX session, pdf.js,
and the tesseract worker; the service worker owns settings and creates
the document on demand; content scripts only intercept, render the
review UI, and build redacted copies. Verified end to end in headless
Chrome (interception, hold, both release paths, OCR, PDF).

**Model is downloaded at runtime, never committed.**
On first use the extension fetches three files from the public HF repo
CDT5058/phi-redact and caches them in Cache Storage:
`phi-redact-v9-int8.onnx` (11,323,243 B), `tokenizer.json` (711,494 B),
`tags.json` (1,623 B; verified identical in order to config.json's
id2label, 129 BIOES labels). If the download has not happened, scans
fall back to the rules layer and the UI says the scan was partial —
it never pretends a file was fully checked.

**Inference contract ported from phi-redact-sdk 0.3.0, not reinvented.**
Threshold 0.6 (the SDK default, per its golden-set sweep); BIOES decode
is the SDK's lenient decoder; merge policy is rules-win-overlaps with
neural-neural overlaps keeping the higher score; placeholders numbered
per label in document order. `src/lib/rules.js` and `src/lib/merge.js`
are line ports of the SDK's TypeScript; the tokenizer and BIOES code
port the Python engine. Parity is enforced by tests: tokenizer ids and
offsets match HF `tokenizers` output exactly on the fixture set, and
an integration test runs the real v9 model through the vendored
onnxruntime-web bundle and reproduces the Python engine's entities and
redacted text exactly on all short fixtures.

**Reproduce the SDK's doubled [CLS]/[SEP], do not "fix" it.**
tokenizer.json has a TemplateProcessing post-processor, so
`tokenizers` encode() already returns [CLS]...[SEP]; the SDK engine
then wraps ids in a second [CLS]/[SEP] pair. The shipped, measured
behavior includes the doubling, so the port reproduces it (documented
in `src/lib/tokenizer.js`).

**Diverge from the SDK on long texts: chunk fully.**
tokenizer.json also enables truncation at 256 tokens. In the SDK
engine this silently caps the neural scan: its chunk-length check
(`_split`) reads the already-truncated token count, so chunking never
engages and text past ~254 tokens is never neurally scanned (rules
still scan everything). Evidence: reference run on a 452-token sample —
neural detections stop exactly at the truncation boundary, including a
half-name span scored 0.89. An upload scanner whose purpose is not
missing PII in long documents should not inherit that cap, so the
extension encodes with truncation disabled and chunks at the engine's
own max_len of 384 with its 96-char overlap. Texts under the limit are
byte-identical in behavior (parity-tested); the integration test
asserts the reference entities are all found on the long sample, with
the single truncation-edge fragment allowed to be covered by the full
span instead. Worth raising upstream in the SDK repo.

**Vendored runtimes are committed (26.9 MB), weights are not.**
MV3 forbids remotely hosted code, so onnxruntime-web (WASM bundle +
simd-threaded binary), pdf.js (lib + worker), and tesseract.js (API,
worker, LSTM cores) are committed under `vendor/`, regenerated by
`scripts/vendor.mjs` from pinned npm versions. Only the files actually
loaded are vendored (onnxruntime-web's dist ships ~135 MB of variants).

**tesseract worker loads directly (workerBlobURL: false).**
With tesseract's default, the worker is wrapped in a blob worker whose
opaque origin cannot importScripts the chrome-extension:// worker
script (observed NetworkError in Chrome). Loading the worker directly
from its extension URL works and needs no web_accessible_resources.

**OCR language data is downloaded once, treated as data.**
`eng.traineddata.gz` is fetched from a pinned jsDelivr URL
(`@tesseract.js-data/eng@1.0.0/4.0.0`) and cached by tesseract.js in
IndexedDB. It is data, not code; vendoring it would add ~2 MB to git
for no privacy gain — no document content is involved in the request.

**Redacted PDF = redacted text (.txt) in v1.**
Rebuilding a layout-faithful PDF with spans removed needs span-to-page
geometry the text layer does not reliably provide. v1 downloads/uploads
the placeholder-applied text and says so in the UI and README. Scanned
PDFs route through OCR for at most 5 pages (noted in the result).

**Interception is best-effort with an honest fallback.**
Capture-phase hooks on file-input change, drop, and paste cover
standard widgets. Release re-dispatches with a DataTransfer; where a
site will not accept programmatic assignment, the panel falls back to
offering downloads for manual attach instead of claiming the upload
was protected.

**The SDK's neural-span checksum gate is NOT implemented here.**
`docs/neural-span-validation.md` in the SDK repo specifies gating
neural SSN/card/IBAN/routing spans through the rules validators, but
it is an unimplemented spec awaiting a decision there. The extension
matches shipped SDK 0.3.0 behavior; adding the gate here first would
create a third behavior. Revisit when the SDK decides.

## Addendum 2026-10-25 — SDK fixed upstream; the divergence is closed

SDK 0.3.1 (ctrimm/phi-redact-sdk, Cory's word) fixes the tokenizer
truncation cap at the source: the Python engine now strips the
truncation block from the serialized tokenizer config at load, so its
own 384-token chunking governs — the same policy this extension adopted
at v1. The deliberate divergence recorded above no longer exists;
extension and SDK agree on long-document behavior again. Regression
tests and the real-model A/B evidence are in the SDK repo's decision
log (2026-10-25 entry).
