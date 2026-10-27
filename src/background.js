/**
 * phi-redact Upload Guard — background service worker.
 *
 * Owns settings (chrome.storage.local) and the offscreen document that
 * hosts the model, PDF extraction and OCR. Content scripts and the
 * popup/options pages talk to this worker with messages shaped
 * { target: "background", type: ... }; scan work is forwarded to the
 * offscreen document, which listens for { target: "offscreen", ... }.
 */

export const SETTINGS_KEY = "phi-redact-settings";

export const DEFAULT_SETTINGS = {
  enabled: true,
  threshold: 0.6, // SDK default (phi-redact-sdk 0.3.0)
  autoDownloadModel: true,
  disabledSites: [], // hostnames, e.g. "example.com"
  // SDK 0.4.0 parity: anonymize operator + allow/deny lists.
  operator: "numbered", // numbered | label | mask | hash | remove
  salt: "", // hash-operator salt (only used when operator is "hash")
  allowlist: [], // terms never redacted (case-insensitive exact match)
  denylist: [], // terms always redacted, labeled CUSTOM
  // SDK 0.5.0 parity: custom recognizers, per-label thresholds,
  // needs-review mode.
  recognizers: [], // [{ label, patterns, score?, context?, ... }]
  thresholds: {}, // label -> threshold override
  reviewEnabled: false,
  reviewMargin: 0.15, // band width below the gate flagged for review
};

async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] ?? {}) };
}

async function setSettings(patch) {
  // Serialize read-modify-write: several patches in quick succession
  // (the options page saving a section) must not read the same stale
  // snapshot and clobber each other.
  const run = settingsWrite.then(async () => {
    const next = { ...(await getSettings()), ...patch };
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    return next;
  });
  settingsWrite = run.catch(() => {});
  return run;
}

let settingsWrite = Promise.resolve();

// ---------------------------------------------------------------------------
// Offscreen document lifecycle
// ---------------------------------------------------------------------------

let creatingOffscreen = null;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: "src/offscreen/offscreen.html",
        reasons: ["WORKERS"],
        justification:
          "Hosts the on-device redaction model (ONNX Runtime), PDF text extraction, and OCR so uploads can be scanned locally; no document data leaves the browser.",
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

async function forwardToOffscreen(message) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ ...message, target: "offscreen" });
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== "background") return;
  (async () => {
    try {
      switch (message.type) {
        case "ensure-offscreen":
          await ensureOffscreen();
          sendResponse({ ok: true });
          break;
        case "get-settings":
          sendResponse({ ok: true, settings: await getSettings() });
          break;
        case "set-settings":
          sendResponse({ ok: true, settings: await setSettings(message.patch ?? {}) });
          break;
        case "model-status":
        case "model-download":
        case "model-clear":
          sendResponse(await forwardToOffscreen(message));
          break;
        default:
          sendResponse({ ok: false, error: `unknown type ${message.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message ?? err) });
    }
  })();
  return true; // async response
});

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  if (!stored[SETTINGS_KEY]) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  }
});
