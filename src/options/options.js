/** phi-redact Upload Guard — options page. */

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

async function refresh() {
  const resp = await bg("get-settings");
  const s = resp?.settings ?? {};
  $("enabled").checked = s.enabled !== false;
  $("auto-download").checked = s.autoDownloadModel !== false;
  const th = Number(s.threshold ?? 0.6);
  $("threshold").value = String(th);
  $("threshold-value").textContent = th.toFixed(2);
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
