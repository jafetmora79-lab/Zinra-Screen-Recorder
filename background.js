import { migrateSettings } from "./settings.js";

let recordingTabId = null;
let screenOriginTabId = null;
let recorderTabId = null;
let recorderPort = null;
let pendingDesktopId = null;
let pendingDesktopTimer = 0;
let recordingLive = false;
let screenTrackClicks = false;
let armedScreenTabId = null;
let stopPanelWindowId = null;
const pendingPointer = [];

async function armTab(tabId) {
  if (!tabId) return;
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    files: ["content.js"]
  }).catch(() => {});
  await chrome.tabs.sendMessage(tabId, { type: "zinra-arm" }).catch(() => {});
}

async function retargetScreenTracking(tabId) {
  if (!screenTrackClicks || tabId === armedScreenTabId) return;
  if (armedScreenTabId) disarmTab(armedScreenTabId);
  await armTab(tabId);
  armedScreenTabId = tabId;
}

async function openStopPanel(returnTabId) {
  if (stopPanelWindowId) return;
  try {
    const current = await chrome.windows.getLastFocused();
    const width = 236;
    const height = 88;
    const left = Math.max(0, (current.left || 0) + (current.width || 1200) - width - 20);
    const top = Math.max(0, (current.top || 0) + (current.height || 800) - height - 28);
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL("stop-panel.html"),
      type: "popup",
      focused: false,
      width,
      height,
      left,
      top
    });
    stopPanelWindowId = win?.id || null;
    if (returnTabId) chrome.tabs.update(returnTabId, { active: true }).catch(() => {});
  } catch {
    // Popup + shortcut still stop the take.
  }
}

function closeStopPanel() {
  const id = stopPanelWindowId;
  stopPanelWindowId = null;
  if (id) chrome.windows.remove(id).catch(() => {});
}

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
  if (id === armedScreenTabId) armedScreenTabId = null;
  if (id === recorderTabId) {
    disarmTab(recordingTabId);
    disarmTab(armedScreenTabId);
    recorderTabId = null;
    recordingTabId = null;
    screenOriginTabId = null;
    recorderPort = null;
    recordingLive = false;
    screenTrackClicks = false;
    armedScreenTabId = null;
    closeStopPanel();
    chrome.action.setBadgeText({ text: "" });
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (!recordingLive) return;
  retargetScreenTracking(tabId);
});

chrome.windows.onRemoved.addListener((id) => {
  if (id === stopPanelWindowId) stopPanelWindowId = null;
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
    chrome.storage.sync.get(null).then((stored) => {
      return chrome.storage.sync.set(migrateSettings({ ...stored, ...msg.settings }));
    }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === "start") {
    if (msg.mode === "screen") {
      beginScreenCapture(msg.tab, msg.tabId);
      sendResponse({ ok: true });
      return false;
    }
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

  if (msg.type === "prepare-desktop") {
    const streamId = pendingDesktopId;
    pendingDesktopId = null;
    if (pendingDesktopTimer) {
      clearTimeout(pendingDesktopTimer);
      pendingDesktopTimer = 0;
    }
    if (!streamId) {
      sendResponse({ ok: false, error: "No screen was picked." });
      return false;
    }
    sendResponse({ ok: true, streamId });
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
    recordingLive = true;
    const returnTabId = recordingTabId || screenOriginTabId;
    if (recordingTabId) {
      // Tab capture: the content script needs re-arming on the recorded tab
      // (it may have been torn down while the recorder tab was loading), then
      // that tab comes back into focus so the user is looking at what's live.
      armTab(recordingTabId);
    } else if (msg.trackClicks && screenOriginTabId) {
      // Screen/window capture of a Chrome source: best-effort click tracking
      // on whichever tab has focus, re-targeted as the user switches tabs.
      screenTrackClicks = true;
      armTab(screenOriginTabId);
      armedScreenTabId = screenOriginTabId;
    }
    if (returnTabId) {
      chrome.tabs.update(returnTabId, { active: true }).catch(() => {});
    }
    // Entire-screen shares would film this window, so skip it there —
    // Chrome's own sharing bar can stop those. Tab/window captures stay
    // clean because the control lives outside the recorded page.
    const entireScreen = msg.mode === "screen" && !msg.trackClicks;
    if (!entireScreen) openStopPanel(returnTabId);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "recording-stopped") {
    chrome.action.setBadgeText({ text: "" });
    disarmTab(recordingTabId);
    disarmTab(armedScreenTabId);
    recordingTabId = null;
    screenOriginTabId = null;
    recordingLive = false;
    screenTrackClicks = false;
    armedScreenTabId = null;
    closeStopPanel();
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "zinra-stop-bubble-click") {
    stopRecording();
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "enter-editor") {
    const target = sender.tab?.id || recorderTabId;
    if (target) chrome.tabs.update(target, { active: true }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

async function startRecording(tabId, mode, options = {}) {
  // recorderTabId stays set after a recording finishes - that tab just
  // switches from capturing to editing, it doesn't close. Only treat it as
  // "already busy" while actually recording; otherwise a finished editor
  // tab left open (e.g. to film the Studio itself in a second recording)
  // would silently swallow every new "start" as a refocus of the old tab.
  if (recorderTabId && recordingLive) {
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
    // Screen/window capture isn't tied to a single tab yet - we won't know
    // whether it's worth tracking clicks until the user actually picks a
    // source (see the trackClicks branch in recording-started below). Just
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
    // After a desktop picker, stay on the page the user was filming. The
    // recorder tab still has to exist (that's where MediaRecorder lives) but
    // it should not steal the window.
    active: options.active !== false
  });
  recorderTabId = rec.id;
}

function rememberDesktopId(streamId) {
  pendingDesktopId = streamId;
  if (pendingDesktopTimer) clearTimeout(pendingDesktopTimer);
  pendingDesktopTimer = setTimeout(() => {
    pendingDesktopId = null;
    pendingDesktopTimer = 0;
  }, 20000);
}

function beginScreenCapture(tab, tabId) {
  const originId = tab?.id || tabId;
  const openFallback = () => {
    if (originId) startRecording(originId, "screen", { active: true }).catch(() => {});
  };
  if (!originId || !chrome.desktopCapture?.chooseDesktopMedia) {
    openFallback();
    return;
  }
  // Called in the same turn as the popup click message so Chrome still
  // treats it as a user gesture. The picker sits on the current window —
  // not on a Zinra tab — then the recorder opens in the background.
  const sources = ["screen", "window", "tab", "audio"];
  const onPicked = (streamId) => {
    if (!streamId) return;
    rememberDesktopId(streamId);
    startRecording(originId, "screen", { active: false }).catch(openFallback);
  };
  try {
    if (tab?.id) chrome.desktopCapture.chooseDesktopMedia(sources, tab, onPicked);
    else chrome.desktopCapture.chooseDesktopMedia(sources, onPicked);
  } catch {
    try {
      chrome.desktopCapture.chooseDesktopMedia(["screen", "window", "tab"], onPicked);
    } catch {
      openFallback();
    }
  }
}

function stopRecording() {
  disarmTab(recordingTabId);
  chrome.runtime.sendMessage({ type: "recorder-stop" }).catch(() => {});
  if (recorderTabId) {
    chrome.tabs.sendMessage(recorderTabId, { type: "recorder-stop" }).catch(() => {});
  }
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
