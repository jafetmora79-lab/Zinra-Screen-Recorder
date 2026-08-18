import { migrateSettings } from "./settings.js";

let recordingTabId = null;
let recorderTabId = null;
let recorderPort = null;
const pendingPointer = [];

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
    port.onMessage.addListener((msg) => {
      try {
        if (recorderPort) recorderPort.postMessage(msg);
        else if (pendingPointer.length < 240) pendingPointer.push(msg);
      } catch {
        // Recorder tab closed.
      }
    });
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
    if (recordingTabId) {
      chrome.tabs.sendMessage(recordingTabId, { type: "zinra-disarm" }).catch(() => {});
    }
    recorderTabId = null;
    recordingTabId = null;
    recorderPort = null;
    chrome.action.setBadgeText({ text: "" });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "get-state") {
    chrome.storage.sync.get(null).then((stored) => {
      sendResponse({
        recording: Boolean(recordingTabId),
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
    startRecording(msg.tabId).then(() => sendResponse({ ok: true })).catch((err) => {
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
      chrome.tabs.sendMessage(recordingTabId, { type: "zinra-arm" }).catch(() => {});
      chrome.tabs.update(recordingTabId, { active: true }).catch(() => {});
    }
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "recording-stopped") {
    chrome.action.setBadgeText({ text: "" });
    if (recordingTabId) {
      chrome.tabs.sendMessage(recordingTabId, { type: "zinra-disarm" }).catch(() => {});
    }
    recordingTabId = null;
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

async function startRecording(tabId) {
  if (recorderTabId) {
    try {
      await chrome.tabs.update(recorderTabId, { active: true });
      return;
    } catch {
      recorderTabId = null;
    }
  }

  recordingTabId = tabId;
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    files: ["content.js"]
  }).catch(() => {});
  await chrome.tabs.sendMessage(tabId, { type: "zinra-arm" }).catch(() => {});

  const source = await chrome.tabs.get(tabId);
  const rec = await chrome.tabs.create({
    url: chrome.runtime.getURL(`recorder.html?tab=${tabId}`),
    windowId: source.windowId,
    index: (source.index ?? 0) + 1,
    active: true
  });
  recorderTabId = rec.id;
}

function stopRecording() {
  if (recordingTabId) {
    chrome.tabs.sendMessage(recordingTabId, { type: "zinra-disarm" }).catch(() => {});
  }
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
