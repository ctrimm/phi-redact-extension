/** phi-redact Upload Guard — options page. */

import { checkRecognizer } from "../lib/merge.js";

const $ = (id) => document.getElementById(id);

async function bg(type, extra = {}) {
  return chrome.runtime.sendMessage({ target: "background", type, ...extra });
}

function renderModelStatus(status) {
  const el = $("model-status");
  if (!status) {
    el.textContent = "Status unavailable.";
    return;
  }
  const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  switch (status.state) {
    case "ready":
      el.textContent = "Model v9 is downloaded and loaded.";
      break;
    case "cached":
      el.textContent = "Model v9 is downloaded. It loads on the first scan.";
      break;
    case "downloading":
      el.textContent = `Downloading... ${mb(status.downloadedBytes)} of ${mb(status.totalBytes)}`;
      break;
    case "loading":
      el.textContent = "Loading the model...";
      break;
    case "error":
      el.textContent = `Model problem: ${status.error ?? "unknown error"}`;
      break;
    default:
      el.textContent = "Model not downloaded yet.";
  }
}

let currentSites = [];

function renderSites() {
  const ul = $("site-list");
  ul.replaceChildren();
  if (currentSites.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No disabled sites.";
    ul.appendChild(li);
    return;
  }
  for (const host of currentSites) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = host;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Remove";
    btn.addEventListener("click", async () => {
      currentSites = currentSites.filter((h) => h !== host);
      await bg("set-settings", { patch: { disabledSites: currentSites } });
      renderSites();
    });
    li.append(span, btn);
    ul.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// Per-label thresholds
// ---------------------------------------------------------------------------

let currentThresholds = {}; // label -> number

function renderThresholdRows() {
  const host = $("threshold-rows");
  host.replaceChildren();
  for (const [label, value] of Object.entries(currentThresholds)) {
    host.appendChild(thresholdRow(label, value));
  }
}

function thresholdRow(label, value) {
  const row = document.createElement("div");
  row.className = "trow";
  const lab = document.createElement("input");
  lab.type = "text";
  lab.placeholder = "LABEL, e.g. NAME_PATIENT";
  lab.value = label;
  lab.spellcheck = false;
  const num = document.createElement("input");
  num.type = "number";
  num.min = "0";
  num.max = "1";
  num.step = "0.05";
  num.value = String(value);
  const rm = document.createElement("button");
  rm.type = "button";
  rm.textContent = "Remove";
  const commit = async () => {
    const key = lab.value.trim();
    const v = Number(num.value);
    const next = { ...currentThresholds };
    if (label && label !== key) delete next[label];
    if (key && v >= 0 && v <= 1) next[key] = v;
    currentThresholds = next;
    await bg("set-settings", { patch: { thresholds: currentThresholds } });
    renderThresholdRows();
  };
  lab.addEventListener("change", commit);
  num.addEventListener("change", commit);
  rm.addEventListener("click", async () => {
    const next = { ...currentThresholds };
    delete next[lab.value.trim() || label];
    currentThresholds = next;
    await bg("set-settings", { patch: { thresholds: currentThresholds } });
    renderThresholdRows();
  });
  row.append(lab, num, rm);
  return row;
}

// ---------------------------------------------------------------------------
// Custom recognizers
// ---------------------------------------------------------------------------

let currentRecognizers = [];

function recognizerRow(rec, idx) {
  const box = document.createElement("div");
  box.className = "rec";

  const grid = document.createElement("div");
  grid.className = "grid";

  const mkField = (labelText, node, wide = false) => {
    const lab = document.createElement("label");
    if (wide) lab.className = "wide";
    lab.append(document.createTextNode(labelText), node);
    return lab;
  };
  const textInput = (value, placeholder) => {
    const i = document.createElement("input");
    i.type = "text";
    i.value = value ?? "";
    i.placeholder = placeholder ?? "";
    i.spellcheck = false;
    i.style.width = "100%";
    i.style.boxSizing = "border-box";
    return i;
  };

  const fLabel = textInput(rec.label, "EMPLOYEE_ID");
  const fPatterns = document.createElement("textarea");
  fPatterns.rows = 2;
  fPatterns.spellcheck = false;
  fPatterns.value = (rec.patterns ?? []).join("\n");
  fPatterns.placeholder = "EMP-\\d{6}  (one pattern per line)";
  const fScore = document.createElement("input");
  fScore.type = "number";
  fScore.min = "0";
  fScore.max = "1";
  fScore.step = "0.05";
  fScore.value = String(rec.score ?? 0.85);
  fScore.style.width = "100%";
  fScore.style.boxSizing = "border-box";
  const fContext = textInput(
    (rec.context ?? []).join(", "),
    "employee, badge (comma-separated)",
  );
  const fValidator = document.createElement("select");
  for (const [v, t] of [
    ["", "None"],
    ["luhn", "Luhn (cards)"],
    ["ssn", "SSN format"],
    ["iban", "IBAN checksum"],
    ["aba", "ABA routing checksum"],
  ]) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = t;
    fValidator.appendChild(o);
  }
  fValidator.value = typeof rec.validator === "string" ? rec.validator : "";
  const fRequire = document.createElement("input");
  fRequire.type = "checkbox";
  fRequire.checked = rec.requireContext === true;
  const requireLab = document.createElement("label");
  requireLab.className = "check";
  requireLab.append(fRequire, document.createTextNode("Require a context word nearby"));

  grid.append(
    mkField("Label", fLabel),
    mkField("Score (0–1)", fScore),
    mkField("Patterns — one regular expression per line", fPatterns, true),
    mkField("Context words", fContext),
    mkField("Validator", fValidator),
  );
  box.appendChild(grid);
  box.appendChild(requireLab);

  const err = document.createElement("div");
  err.className = "err";
  box.appendChild(err);

  const read = () => {
    const out = {
      label: fLabel.value.trim(),
      patterns: fPatterns.value.split("\n").map((s) => s.trim()).filter(Boolean),
      score: Number(fScore.value),
    };
    const ctx = fContext.value.split(",").map((s) => s.trim()).filter(Boolean);
    if (ctx.length > 0) out.context = ctx;
    if (fValidator.value) out.validator = fValidator.value;
    if (fRequire.checked) out.requireContext = true;
    return out;
  };
  const validate = () => {
    const problem = checkRecognizer(read());
    err.textContent = problem ?? "";
    return problem === null;
  };
  for (const node of [fLabel, fPatterns, fScore, fContext, fValidator, fRequire]) {
    node.addEventListener("input", validate);
    node.addEventListener("change", validate);
  }

  const actions = document.createElement("div");
  actions.className = "rec-actions";
  const save = document.createElement("button");
  save.type = "button";
  save.textContent = "Save recognizer";
  save.addEventListener("click", async () => {
    if (!validate()) return;
    currentRecognizers[idx] = read();
    await bg("set-settings", { patch: { recognizers: currentRecognizers } });
    save.textContent = "Saved";
    setTimeout(() => { save.textContent = "Save recognizer"; }, 1200);
  });
  const del = document.createElement("button");
  del.type = "button";
  del.textContent = "Delete";
  del.addEventListener("click", async () => {
    currentRecognizers.splice(idx, 1);
    await bg("set-settings", { patch: { recognizers: currentRecognizers } });
    renderRecognizers();
  });
  actions.append(save, del);
  box.appendChild(actions);
  validate();
  return box;
}

function renderRecognizers() {
  const host = $("recognizer-rows");
  host.replaceChildren();
  currentRecognizers.forEach((rec, i) => host.appendChild(recognizerRow(rec, i)));
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

const parseLines = (value) =>
  [...new Set(value.split("\n").map((s) => s.trim()).filter(Boolean))];

// ---------------------------------------------------------------------------
// Refresh + wiring
// ---------------------------------------------------------------------------

async function refresh() {
  const resp = await bg("get-settings");
  const s = resp?.settings ?? {};
  $("enabled").checked = s.enabled !== false;
  $("auto-download").checked = s.autoDownloadModel !== false;
  const th = Number(s.threshold ?? 0.6);
  $("threshold").value = String(th);
  $("threshold-value").textContent = th.toFixed(2);
  $("review-enabled").checked = s.reviewEnabled === true;
  const rm = Number(s.reviewMargin ?? 0.15);
  $("review-margin").value = String(rm);
  $("review-margin-value").textContent = rm.toFixed(2);
  $("review-margin-row").style.opacity = s.reviewEnabled === true ? "1" : "0.45";
  $("operator").value = s.operator ?? "numbered";
  $("salt").value = s.salt ?? "";
  $("salt-row").style.display = (s.operator ?? "numbered") === "hash" ? "" : "none";
  $("allowlist").value = (s.allowlist ?? []).join("\n");
  $("denylist").value = (s.denylist ?? []).join("\n");
  currentThresholds = s.thresholds ?? {};
  renderThresholdRows();
  currentRecognizers = s.recognizers ?? [];
  renderRecognizers();
  currentSites = s.disabledSites ?? [];
  renderSites();
  const st = await bg("model-status");
  renderModelStatus(st?.status);
}

$("enabled").addEventListener("change", (e) =>
  bg("set-settings", { patch: { enabled: e.target.checked } }),
);
$("auto-download").addEventListener("change", (e) =>
  bg("set-settings", { patch: { autoDownloadModel: e.target.checked } }),
);
$("threshold").addEventListener("input", (e) => {
  $("threshold-value").textContent = Number(e.target.value).toFixed(2);
});
$("threshold").addEventListener("change", (e) =>
  bg("set-settings", { patch: { threshold: Number(e.target.value) } }),
);
$("review-enabled").addEventListener("change", (e) => {
  $("review-margin-row").style.opacity = e.target.checked ? "1" : "0.45";
  bg("set-settings", { patch: { reviewEnabled: e.target.checked } });
});
$("review-margin").addEventListener("input", (e) => {
  $("review-margin-value").textContent = Number(e.target.value).toFixed(2);
});
$("review-margin").addEventListener("change", (e) =>
  bg("set-settings", { patch: { reviewMargin: Number(e.target.value) } }),
);
$("operator").addEventListener("change", (e) => {
  $("salt-row").style.display = e.target.value === "hash" ? "" : "none";
  bg("set-settings", { patch: { operator: e.target.value } });
});
$("salt").addEventListener("change", (e) =>
  bg("set-settings", { patch: { salt: e.target.value } }),
);
$("threshold-add").addEventListener("click", () => {
  $("threshold-rows").appendChild(thresholdRow("", 0.6));
});
$("lists-save").addEventListener("click", async () => {
  await bg("set-settings", {
    patch: {
      allowlist: parseLines($("allowlist").value),
      denylist: parseLines($("denylist").value),
    },
  });
  $("lists-saved").textContent = "Saved.";
  setTimeout(() => { $("lists-saved").textContent = ""; }, 1500);
});
$("recognizer-add").addEventListener("click", () => {
  currentRecognizers.push({ label: "", patterns: [], score: 0.85 });
  renderRecognizers();
});
$("model-download").addEventListener("click", async () => {
  $("model-status").textContent = "Downloading...";
  const st = await bg("model-download");
  renderModelStatus(st?.status);
  refresh();
});
$("model-clear").addEventListener("click", async () => {
  const st = await bg("model-clear");
  renderModelStatus(st?.status);
  refresh();
});
$("site-add-btn").addEventListener("click", async () => {
  const host = $("site-add").value.trim().toLowerCase();
  if (!host) return;
  if (!currentSites.includes(host)) currentSites.push(host);
  await bg("set-settings", { patch: { disabledSites: currentSites } });
  $("site-add").value = "";
  renderSites();
});
chrome.runtime.onMessage.addListener((m) => {
  if (m?.target === "broadcast" && m.type === "model-status") {
    renderModelStatus(m.status);
  }
});

refresh();
