/**
 * phi-redact Upload Guard — action popup.
 * Settings and model state live in the background worker / offscreen
 * document; this page only renders and patches them.
 */

const $ = (id) => document.getElementById(id);

async function bg(type, extra = {}) {
  return chrome.runtime.sendMessage({ target: "background", type, ...extra });
}

function renderModelStatus(status) {
  const body = $("model-status");
  const btn = $("model-download");
  btn.hidden = true;
  if (!status) {
    body.textContent = "Status unavailable.";
    return;
  }
  const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  switch (status.state) {
    case "ready":
      body.textContent = "Downloaded and loaded. Scans run fully on-device.";
      break;
    case "cached":
      body.textContent = "Downloaded. It loads the first time a scan runs.";
      break;
    case "downloading":
      body.textContent = `Downloading... ${mb(status.downloadedBytes)} of ${mb(status.totalBytes)}`;
      break;
    case "loading":
      body.textContent = "Loading the model...";
      break;
    case "error":
      body.textContent = `Model problem: ${status.error ?? "unknown error"}`;
      btn.hidden = false;
      btn.textContent = "Retry download";
      break;
    default:
      body.textContent = "Not downloaded yet. Until it is, scans use the rules layer only and say so.";
      btn.hidden = false;
      btn.textContent = "Download model (about 12 MB)";
  }
}

async function refresh() {
  const resp = await bg("get-settings");
  const settings = resp?.settings ?? {};
  $("enabled").checked = settings.enabled !== false;
  $("threshold").textContent = Number(settings.threshold ?? 0.6).toFixed(2);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = null;
  try {
    host = tab?.url ? new URL(tab.url).hostname : null;
  } catch {
    host = null;
  }
  const siteBtn = $("site-toggle");
  if (host) {
    $("site-label").textContent = `This site: ${host}`;
    const disabled = (settings.disabledSites ?? []).includes(host);
    siteBtn.textContent = disabled ? "Enable here" : "Disable here";
    siteBtn.onclick = async () => {
      const cur = new Set(settings.disabledSites ?? []);
      if (disabled) cur.delete(host);
      else cur.add(host);
      await bg("set-settings", { patch: { disabledSites: [...cur] } });
      refresh();
    };
  } else {
    $("site-label").textContent = "This site: not applicable";
    siteBtn.disabled = true;
  }

  const st = await bg("model-status");
  renderModelStatus(st?.status);
}

$("enabled").addEventListener("change", async (e) => {
  await bg("set-settings", { patch: { enabled: e.target.checked } });
});
$("model-download").addEventListener("click", async () => {
  $("model-download").hidden = true;
  $("model-status").textContent = "Downloading...";
  const st = await bg("model-download");
  renderModelStatus(st?.status);
});
$("open-options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
chrome.runtime.onMessage.addListener((m) => {
  if (m?.target === "broadcast" && m.type === "model-status") {
    renderModelStatus(m.status);
  }
});

refresh();
