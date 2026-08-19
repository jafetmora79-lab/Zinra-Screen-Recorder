import { DEFAULTS, migrateSettings, remainingFreeExports } from "./settings.js";

const fields = {
  autoMarkClicks: document.getElementById("autoMarkClicks"),
  clickZoom: document.getElementById("clickZoom"),
  zoomDuration: document.getElementById("zoomDuration"),
  includeAudio: document.getElementById("includeAudio"),
  includeCamera: document.getElementById("includeCamera"),
  quality: document.getElementById("quality")
};

const clickZoomVal = document.getElementById("clickZoomVal");
const zoomDurationVal = document.getElementById("zoomDurationVal");
const recordBtn = document.getElementById("recordBtn");
const recordScreenBtn = document.getElementById("recordScreenBtn");
const errorEl = document.getElementById("error");
const statusDot = document.getElementById("statusDot");

function showError(message) {
  errorEl.textContent = message || "";
  errorEl.classList.toggle("hidden", !message);
}

function readSettings() {
  return {
    autoMarkClicks: fields.autoMarkClicks.checked,
    clickZoom: Number(fields.clickZoom.value),
    zoomDuration: Number(fields.zoomDuration.value),
    includeAudio: fields.includeAudio.checked,
    includeCamera: fields.includeCamera.checked,
    quality: fields.quality.value
  };
}

function applySettings(settings) {
  const next = migrateSettings(settings);
  fields.autoMarkClicks.checked = next.autoMarkClicks !== false;
  fields.clickZoom.value = next.clickZoom ?? DEFAULTS.clickZoom;
  fields.zoomDuration.value = next.zoomDuration ?? DEFAULTS.zoomDuration;
  fields.includeAudio.checked = next.includeAudio !== false;
  fields.includeCamera.checked = Boolean(next.includeCamera);
  fields.quality.value = next.quality || DEFAULTS.quality;
  clickZoomVal.textContent = `${Number(fields.clickZoom.value).toFixed(2)}×`;
  zoomDurationVal.textContent = `${Number(fields.zoomDuration.value).toFixed(1)}s`;
  refreshProChrome(next);
}

function refreshProChrome(settings) {
  const getPro = document.getElementById("getProBtn");
  const chip = document.getElementById("proChip");
  const note = document.getElementById("proNote");
  const pro = Boolean(settings?.pro);
  getPro?.classList.toggle("hidden", pro);
  chip?.classList.toggle("hidden", !pro);
  if (!note) return;
  if (pro) {
    note.textContent = "Pro is active — unlimited exports, 4K, and extra click effects.";
    return;
  }
  const left = remainingFreeExports(settings);
  note.textContent = left > 0
    ? `${left} free export${left === 1 ? "" : "s"} left. 4K, 60fps, and extra click effects are Pro.`
    : "Free exports used. Get Pro for unlimited exports, 4K, and extra click effects.";
}

function setRecordUi(recording) {
  const icon = recordBtn.querySelector(".ui-icon");
  const label = recordBtn.querySelector(".btn-label");
  recordScreenBtn.classList.toggle("hidden", recording);
  const stopHint = document.getElementById("stopHint");
  if (stopHint) stopHint.classList.toggle("hidden", !recording);
  if (recording) {
    if (icon) icon.src = "icons/svg/stop.svg";
    if (label) label.textContent = "Stop recording";
    recordBtn.classList.remove("primary");
    recordBtn.classList.add("danger");
    statusDot.className = "hud-chip live";
    statusDot.textContent = "REC";
  } else {
    if (icon) icon.src = "icons/svg/record.svg";
    if (label) label.textContent = "Record this page";
    recordBtn.classList.add("primary");
    recordBtn.classList.remove("danger");
    statusDot.className = "hud-chip idle";
    statusDot.textContent = "Ready";
  }
}

async function persist() {
  await chrome.runtime.sendMessage({ type: "save-settings", settings: readSettings() });
}

function wire() {
  for (const el of Object.values(fields)) {
    el.addEventListener("change", persist);
    el.addEventListener("input", () => {
      clickZoomVal.textContent = `${Number(fields.clickZoom.value).toFixed(2)}×`;
      zoomDurationVal.textContent = `${Number(fields.zoomDuration.value).toFixed(1)}s`;
    });
  }
}

let originTab = null;

recordBtn.addEventListener("click", async () => {
  showError("");
  await persist();
  const state = await chrome.runtime.sendMessage({ type: "get-state" });
  if (state.recording) {
    await chrome.runtime.sendMessage({ type: "stop" });
    window.close();
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    showError("No active tab to record.");
    return;
  }
  if (tab.url?.startsWith("chrome://") || tab.url?.startsWith("edge://") || tab.url?.startsWith("chrome-extension://")) {
    showError("Open a normal webpage first — Chrome pages can’t be captured.");
    return;
  }
  const result = await chrome.runtime.sendMessage({ type: "start", tabId: tab.id, mode: "tab" });
  if (!result?.ok) {
    showError(result?.error || "Could not start recording.");
    return;
  }
  window.close();
});

recordScreenBtn.addEventListener("click", () => {
  showError("");
  persist();
  const tab = originTab;
  chrome.runtime.sendMessage(
    { type: "start", tabId: tab?.id, tab, mode: "screen" },
    (result) => {
      if (chrome.runtime.lastError) {
        showError(chrome.runtime.lastError.message);
        return;
      }
      if (result && result.ok === false) {
        showError(result.error || "Could not start recording.");
        return;
      }
      window.close();
    }
  );
});

(async function init() {
  wire();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  originTab = tab || null;
  const state = await chrome.runtime.sendMessage({ type: "get-state" });
  applySettings(state.settings);
  setRecordUi(state.recording);
  document.getElementById("getProBtn")?.addEventListener("click", () => {
    chrome.tabs.create({ url: "https://zinrastudio.lemonsqueezy.com/checkout/buy/835ba522-81e3-4487-9549-def8dd233e84" });
  });
})();
