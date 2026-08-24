import { mergeExportCount, migrateSettings } from "./settings.js";

const SITE_ORIGIN = "https://jafetmora79-lab.github.io";
const SITE_URL = `${SITE_ORIGIN}/Zinra-Screen-Recorder/entitlement.html`;
const IDB_NAME = "zinra-entitlement";
const IDB_STORE = "kv";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGetCount() {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get("exportCount");
      req.onsuccess = () => resolve(Number(req.result) || 0);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return 0;
  }
}

async function idbSetCount(count) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(count, "exportCount");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Private mode / IDB blocked.
  }
}

function siteFrame() {
  if (typeof document === "undefined") return Promise.resolve(0);
  return new Promise((resolve) => {
    const frame = document.createElement("iframe");
    frame.src = SITE_URL;
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none";
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      window.removeEventListener("message", onMsg);
      frame.remove();
      resolve(Number(value) || 0);
    };
    const timer = setTimeout(() => finish(0), 2200);
    function onMsg(event) {
      if (event.origin !== SITE_ORIGIN) return;
      if (event.source !== frame.contentWindow) return;
      if (event.data?.type !== "zinra-entitlement") return;
      finish(event.data.exportCount);
    }
    window.addEventListener("message", onMsg);
    frame.addEventListener("load", () => {
      try {
        frame.contentWindow.postMessage({ type: "zinra-entitlement-get" }, SITE_ORIGIN);
      } catch {
        finish(0);
      }
    });
    document.documentElement.appendChild(frame);
  });
}

function siteWrite(count) {
  if (typeof document === "undefined") return Promise.resolve();
  return new Promise((resolve) => {
    const frame = document.createElement("iframe");
    frame.src = SITE_URL;
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      window.removeEventListener("message", onMsg);
      frame.remove();
      resolve();
    };
    const timer = setTimeout(finish, 2200);
    function onMsg(event) {
      if (event.origin !== SITE_ORIGIN) return;
      if (event.source !== frame.contentWindow) return;
      if (event.data?.type !== "zinra-entitlement") return;
      finish();
    }
    window.addEventListener("message", onMsg);
    frame.addEventListener("load", () => {
      try {
        frame.contentWindow.postMessage({ type: "zinra-entitlement-set", exportCount: count }, SITE_ORIGIN);
      } catch {
        finish();
      }
    });
    document.documentElement.appendChild(frame);
  });
}

export async function readEntitlement() {
  const [sync, local, idb, site] = await Promise.all([
    chrome.storage.sync.get(null).catch(() => ({})),
    chrome.storage.local.get(["exportCount"]).catch(() => ({})),
    idbGetCount(),
    siteFrame()
  ]);
  const settings = migrateSettings(sync);
  settings.exportCount = mergeExportCount(settings.exportCount, local.exportCount, idb, site);
  return settings;
}

export async function writeExportCount(count) {
  const next = mergeExportCount(count);
  await Promise.all([
    chrome.storage.sync.set({ exportCount: next }).catch(() => {}),
    chrome.storage.local.set({ exportCount: next }).catch(() => {}),
    idbSetCount(next),
    siteWrite(next)
  ]);
  return next;
}

export async function persistLicense(key) {
  const trimmed = String(key || "").trim();
  await chrome.storage.sync.set({ pro: true, licenseKey: trimmed }).catch(() => {});
  await chrome.storage.local.set({ pro: true, licenseKey: trimmed }).catch(() => {});
}
