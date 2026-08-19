import { migrateSettings } from "./settings.js";

let recordingTabId = null;
let screenOriginTabId = null;
let recorderTabId = null;
let recorderPort = null;
const pendingPointer = [];

function forwardPointer(msg) {
  try {
    if (recorderPort) recorderPort.postMessage(msg);
    else if (pendingPointer.length < 240) pendingPointer.push(msg);
  } catch {
    // Recorder tab closed.
  }
}

async function disarmTab(tabId) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, { type: "zinra-disarm" }).catch(() => {});
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => window.dispatchEvent(new CustomEvent("zinra-disarm"))
  }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get(null);
  await chrome.storage.sync.set(migrateSettings(current));
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "zinra-recorder") {
    recorderPort = port;
    while (pendingPointer.length) {
      try { recorderPort.postMessage(pendingPointer.shift()); } catch { break; }
    }
    port.onDisconnect.addListener(() => {
      if (recorderPort === port) recorderPort = null;
    });
  }
  if (port.name === "zinra-pointer") {
    port.onMessage.addListener((msg) => forwardPointer(msg));
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-record") return;
  if (recorderTabId) {
    stopRecording();
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) startRecording(tab.id);
});

chrome.tabs.onRemoved.addListener((id) => {
  if (id === recorderTabId) {
    disarmTab(recordingTabId);
    recorderTabId = null;
    recordingTabId = null;
    screenOriginTabId = null;
    recorderPort = null;
    chrome.action.setBadgeText({ text: "" });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "get-state") {
    chrome.storage.sync.get(null).then((stored) => {
      sendResponse({
        recording: Boolean(recorderTabId),
        recordingTabId,
        settings: migrateSettings(stored)
      });
    });
    return true;
  }

  if (msg.type === "save-settings") {
    chrome.storage.sync.set(migrateSettings(msg.settings)).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === "start") {
    startRecording(msg.tabId, msg.mode).then(() => sendResponse({ ok: true })).catch((err) => {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (msg.type === "stop") {
    stopRecording();
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "prepare-capture") {
    prepareCapture(msg.targetTabId, sender.tab?.id)
      .then((streamId) => sendResponse({ ok: true, streamId }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === "recording-started") {
    chrome.action.setBadgeText({ text: "REC" });
    chrome.action.setBadgeBackgroundColor({ color: "#c45c4a" });
    if (recordingTabId) {
      // Tab capture: the content script needs re-arming on the recorded tab
      // (it may have been torn down while the recorder tab was loading), then
      // that tab comes back into focus so the user is looking at what's live.
      chrome.scripting.executeScript({
        target: { tabId: recordingTabId, allFrames: false },
        files: ["content.js"]
      }).catch(() => {});
      chrome.tabs.sendMessage(recordingTabId, { type: "zinra-arm" }).catch(() => {});
      chrome.tabs.update(recordingTabId, { active: true }).catch(() => {});
    } else if (screenOriginTabId) {
      // Screen/window capture has no single tab to arm - just hand focus
      // back to whatever the user was on before they started sharing.
      chrome.tabs.update(screenOriginTabId, { active: true }).catch(() => {});
    }
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "recording-stopped") {
    chrome.action.setBadgeText({ text: "" });
    disarmTab(recordingTabId);
    recordingTabId = null;
    screenOriginTabId = null;
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "enter-editor" && recorderTabId) {
    chrome.tabs.update(recorderTabId, { active: true }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

async function startRecording(tabId, mode) {
  if (recorderTabId) {
    try {
      await chrome.tabs.update(recorderTabId, { active: true });
      return;
    } catch {
      recorderTabId = null;
    }
  }

  const isScreen = mode === "screen";
  const source = await chrome.tabs.get(tabId);

  if (isScreen) {
    // Screen/window capture isn't tied to a single tab - there's nothing to
    // inject a pointer-tracking content script into, so auto-zoom-on-click
    // simply won't have a signal to work from outside a Chrome tab. Just
    // remember where to send focus back once sharing starts.
    screenOriginTabId = tabId;
  } else {
    recordingTabId = tabId;
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ["content.js"]
    }).catch(() => {});
    await chrome.tabs.sendMessage(tabId, { type: "zinra-arm" }).catch(() => {});
  }

  const rec = await chrome.tabs.create({
    url: chrome.runtime.getURL(`recorder.html?tab=${tabId}&mode=${isScreen ? "screen" : "tab"}`),
    windowId: source.windowId,
    index: (source.index ?? 0) + 1,
    active: true
  });
  recorderTabId = rec.id;
}

function stopRecording() {
  disarmTab(recordingTabId);
  chrome.runtime.sendMessage({ type: "recorder-stop" }).catch(() => {});
}

async function prepareCapture(targetTabId, consumerTabId) {
  if (!targetTabId || !consumerTabId) {
    throw new Error("Missing tab ids for capture.");
  }
  return chrome.tabCapture.getMediaStreamId({
    targetTabId,
    consumerTabId
  });
}
