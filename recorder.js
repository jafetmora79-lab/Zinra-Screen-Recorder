import { openEditor } from "./editor.js";
import {
  applyDetailHint,
  createRecorder,
  pickMime,
  preferHighFps,
  supportsHwMp4,
  trackSize
} from "./encode.js";

import { DEFAULTS } from "./settings.js";
import { readEntitlement } from "./entitlement.js";

const livePreview = document.getElementById("livePreview");
const camHud = document.getElementById("camHud");
const camLive = document.getElementById("camLive");
const hint = document.getElementById("previewHint");
const timerEl = document.getElementById("timer");
const errorEl = document.getElementById("error");
const stopBtn = document.getElementById("stopBtn");
const startBtn = document.getElementById("startBtn");
const shareBtn = document.getElementById("shareBtn");
const statusDot = document.getElementById("statusDot");

const params = new URLSearchParams(location.search);
const targetTabId = Number(params.get("tab"));
const captureMode = params.get("mode") === "screen" ? "screen" : "tab";

let mediaStream = null;
let webcamStream = null;
let recorder = null;
let audioRecorder = null;
let webcamRecorder = null;
let chunks = [];
let audioChunks = [];
let webcamChunks = [];
let samples = [];
let clicks = [];
let focuses = [];
let scrolls = [];
let recOrigin = 0;
let recOriginWall = 0;
let startedAt = 0;
let timerId = 0;
let stopping = false;
let recording = false;
let settingsCache = DEFAULTS;
let captureCache = { width: 0, height: 0, frameRate: 60, mimeType: "" };

function showError(message) {
  errorEl.textContent = message;
  errorEl.classList.toggle("hidden", !message);
}

function setStatus(kind) {
  statusDot.className = `hud-chip ${kind}`;
  statusDot.textContent = kind === "live" ? "REC" : "Ready";
  document.body.classList.toggle("is-live", kind === "live");
}

function formatTime(ms) {
  const total = Math.floor(ms / 1000);
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

async function getSettings() {
  return readEntitlement();
}

async function requestStreamId() {
  const response = await withTimeout(
    chrome.runtime.sendMessage({
      type: "prepare-capture",
      targetTabId
    }),
    5000,
    "Could not reach the capture service. Reload the extension."
  );
  if (!response?.ok) throw new Error(response?.error || "Could not get a tab stream id.");
  return response.streamId;
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    })
  ]);
}

async function getTabStream(settings) {
  // A tab-capture stream id is one-shot. Retrying getUserMedia with the same
  // id after a failure hangs forever in Chrome — always mint a new id.
  async function capture(includeAudio) {
    const id = await requestStreamId();
    const video = {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: id
      }
    };
    const audio = {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: id
      }
    };
    return withTimeout(
      navigator.mediaDevices.getUserMedia(includeAudio ? { audio, video } : { video }),
      8000,
      "Tab capture timed out. Try Start recording or Share tab."
    );
  }

  if (settings.includeAudio) {
    try {
      return await capture(true);
    } catch {
      return await capture(false);
    }
  }
  return capture(false);
}

async function getDisplayStream() {
  const hd = supportsHwMp4();
  const video = {
    frameRate: { ideal: hd ? 60 : 30, max: 60 }
  };
  const audio = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false
  };
  // No preferCurrentTab here on purpose: this runs *inside* the recorder tab
  // itself, so "current tab" would mean Zinra's own blank editor page, not
  // whatever the user actually wants to share - that mismatch was forcing
  // people through an extra decline-then-repick step. Chrome's picker opens
  // straight to the neutral Screen/Window/Tab choice instead.
  try {
    return await navigator.mediaDevices.getDisplayMedia({
      video: { ...video, resizeMode: "crop-and-scale" },
      audio
    });
  } catch {
    return navigator.mediaDevices.getDisplayMedia({ video, audio: true });
  }
}

async function tightenDisplayTrack(track) {
  if (!track?.applyConstraints) return;
  const surface = track.getSettings?.().displaySurface;
  // Window and tab shares on Windows often arrive as a larger GPU texture
  // than the real pixels, with uninitialized (blinking green) rows at the
  // edges. crop-and-scale asks Chrome to deliver only the content box.
  // Entire-screen ("monitor") captures already fill the texture, so leave them.
  if (surface !== "window" && surface !== "browser") return;
  try {
    await track.applyConstraints({ resizeMode: "crop-and-scale" });
  } catch {
    // Older Chrome rejects resizeMode after the picker.
  }
}

async function getDesktopStream(streamId, includeAudio) {
  const video = {
    mandatory: {
      chromeMediaSource: "desktop",
      chromeMediaSourceId: streamId
    }
  };
  const audio = {
    mandatory: {
      chromeMediaSource: "desktop",
      chromeMediaSourceId: streamId
    }
  };
  if (includeAudio) {
    try {
      return await navigator.mediaDevices.getUserMedia({ video, audio });
    } catch {
      return navigator.mediaDevices.getUserMedia({ video });
    }
  }
  return navigator.mediaDevices.getUserMedia({ video });
}

async function getWebcamStream() {
  try {
    return await withTimeout(
      navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 720 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 }
        },
        audio: false
      }),
      8000,
      "Camera timed out."
    );
  } catch {
    return null;
  }
}

function hideCamHud() {
  camHud?.classList.add("hidden");
  if (camLive) camLive.srcObject = null;
}

async function begin(stream, settings) {
  mediaStream = stream;
  settingsCache = settings;

  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) throw new Error("No video track to record.");
  videoTrack.addEventListener("ended", () => {
    if (recording) stop();
  });

  livePreview.srcObject = null;
  livePreview.classList.add("hidden");
  hint.textContent = "Recording. Use the page as usual — this window only needs to stay open.";
  hint.classList.remove("hidden");

  chunks = [];
  audioChunks = [];
  webcamChunks = [];
  samples = [];
  clicks = [];
  focuses = [];
  scrolls = [];

  webcamRecorder = null;
  hideCamHud();
  if (settings.includeCamera) {
    webcamStream = await getWebcamStream();
    if (webcamStream) {
      if (camLive) camLive.srcObject = webcamStream;
      camHud?.classList.remove("hidden");
    } else {
      hint.textContent = "Recording without camera — Chrome didn't allow the webcam. This window only needs to stay open.";
    }
  }

  applyDetailHint(stream);
  await preferHighFps(videoTrack);
  await tightenDisplayTrack(videoTrack);

  const hasAudio = stream.getAudioTracks().length > 0;
  const captureMime = pickMime(hasAudio);
  const size = trackSize(stream);
  const fps = size.frameRate || (supportsHwMp4() ? 60 : 30);
  const displaySurface = videoTrack.getSettings?.().displaySurface || "";
  captureCache = {
    width: size.width,
    height: size.height,
    frameRate: fps,
    mimeType: captureMime,
    displaySurface
  };
  recorder = createRecorder(stream, captureMime, size.width, size.height, fps);
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size) chunks.push(event.data);
  };
  recorder.onerror = () => {
    showError("Recording failed. Try Share tab instead.");
  };

  let videoDone = false;
  let audioDone = true;
  let camDone = true;
  const finish = () => {
    if (videoDone && audioDone && camDone) openEdit();
  };
  recorder.onstop = () => {
    videoDone = true;
    finish();
  };

  audioRecorder = null;
  if (hasAudio) {
    try {
      const audioOnly = new MediaStream(stream.getAudioTracks());
      const audioMime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      audioRecorder = new MediaRecorder(audioOnly, {
        mimeType: audioMime,
        audioBitsPerSecond: 192_000
      });
      audioDone = false;
      audioRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size) audioChunks.push(event.data);
      };
      audioRecorder.onstop = () => {
        audioDone = true;
        finish();
      };
      audioRecorder.onerror = () => {
        audioDone = true;
        finish();
      };
      audioRecorder.start(1000);
    } catch {
      audioRecorder = null;
      audioDone = true;
    }
  }

  if (webcamStream) {
    try {
      const camMime = pickMime(false);
      webcamRecorder = new MediaRecorder(webcamStream, {
        mimeType: camMime,
        videoBitsPerSecond: 2_500_000
      });
      camDone = false;
      webcamRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size) webcamChunks.push(event.data);
      };
      webcamRecorder.onstop = () => {
        camDone = true;
        finish();
      };
      webcamRecorder.onerror = () => {
        camDone = true;
        finish();
      };
      webcamRecorder.start(1000);
    } catch {
      webcamRecorder = null;
      camDone = true;
    }
  }

  recOrigin = performance.now();
  recOriginWall = Date.now();
  recording = true;
  recorder.start(250);
  startedAt = Date.now();
  stopping = false;
  timerId = window.setInterval(() => {
    timerEl.textContent = formatTime(Date.now() - startedAt);
  }, 250);

  stopBtn.disabled = false;
  startBtn.classList.add("hidden");
  shareBtn.classList.add("hidden");
  setStatus("live");
  showError("");
  // getDisplayMedia never tells the page which exact tab/window was picked
  // (that's deliberate, on Chrome's side, for privacy) - but it does say
  // *what kind* of source it was. "monitor" means the whole screen, where a
  // click's page-relative position has no reliable spot in the recorded
  // frame. "browser" (a tab) or "window" at least means Chrome itself is
  // what's being shown, so tracking clicks on whichever tab has focus is a
  // reasonable best-effort guess, even without knowing the exact source.
  const trackClicks = captureMode === "screen" && displaySurface !== "monitor";
  chrome.runtime.sendMessage({ type: "recording-started", mode: captureMode, trackClicks }).catch(() => {});
}

function openEdit() {
  recording = false;
  window.clearInterval(timerId);
  const recordedSeconds = Math.max(0.2, (performance.now() - recOrigin) / 1000);
  const blob = new Blob(chunks, { type: recorder?.mimeType || "video/webm" });
  const audioBlob = audioChunks.length
    ? new Blob(audioChunks, { type: audioRecorder?.mimeType || "audio/webm" })
    : null;
  const webcamBlob = webcamChunks.length
    ? new Blob(webcamChunks, { type: webcamRecorder?.mimeType || "video/webm" })
    : null;
  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;
  webcamStream?.getTracks().forEach((track) => track.stop());
  webcamStream = null;
  livePreview.srcObject = null;
  hideCamHud();
  chrome.runtime.sendMessage({ type: "recording-stopped" }).catch(() => {});

  if (!blob.size) {
    showError("Nothing was recorded. Try Share tab instead.");
    stopBtn.disabled = false;
    stopping = false;
    return;
  }
  try {
    openEditor({
      blob,
      audioBlob,
      webcamBlob,
      samples,
      clicks,
      focuses,
      scrolls,
      settings: settingsCache,
      recordedSeconds,
      capture: captureCache
    });
  } catch (err) {
    showError(err.message || "Could not open the editor.");
    stopBtn.disabled = false;
    stopping = false;
  }
}

async function stop() {
  if (stopping) return;
  stopping = true;
  stopBtn.disabled = true;
  if (recorder && recorder.state !== "inactive") {
    try {
      if (recorder.state === "recording") recorder.requestData();
      if (audioRecorder && audioRecorder.state === "recording") {
        try { audioRecorder.requestData(); audioRecorder.stop(); } catch { /* ignore */ }
      }
      if (webcamRecorder && webcamRecorder.state === "recording") {
        try { webcamRecorder.requestData(); webcamRecorder.stop(); } catch { /* ignore */ }
      }
      recorder.stop();
    } catch (err) {
      showError(err.message || "Could not stop recording.");
      stopping = false;
      stopBtn.disabled = false;
    }
  } else cleanupLive();
}

function cleanupLive() {
  recording = false;
  window.clearInterval(timerId);
  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;
  webcamStream?.getTracks().forEach((track) => track.stop());
  webcamStream = null;
  livePreview.srcObject = null;
  hideCamHud();
  setStatus("idle");
  chrome.runtime.sendMessage({ type: "recording-stopped" }).catch(() => {});
}

function showManualStart(message) {
  setStatus("idle");
  startBtn.classList.remove("hidden");
  shareBtn.classList.remove("hidden");
  hint.textContent = "Click Start recording, or Share tab and pick this page.";
  hint.classList.remove("hidden");
  showError(message || "");
}

// Screen/window capture needs a real click to satisfy getDisplayMedia's user
// -gesture requirement, so it can't auto-start like tab capture does - this
// is the very first thing shown, not a fallback after a failed attempt.
function showScreenModeStart() {
  setStatus("idle");
  startBtn.classList.add("hidden");
  shareBtn.classList.remove("hidden");
  shareBtn.classList.remove("ghost");
  shareBtn.classList.add("primary");
  const label = shareBtn.querySelector(".btn-label");
  if (label) label.textContent = "Share your screen";
  hint.textContent = "Pick the screen or window to record. Chrome shows its own picker and a small sharing bar while you're live — that's normal, and you'll be sent back to what you were doing once sharing starts.";
  hint.classList.remove("hidden");
  // Chrome requires a real click/keypress in this tab before it'll open the
  // picker - a fresh tab doesn't inherit the click that opened it, and the
  // popup can't hold the picker open itself (it closes the moment it loses
  // focus). Focusing the button means Enter/Space works immediately, so
  // there's at least no need to hunt for it with the mouse first.
  shareBtn.focus();
}

startBtn.addEventListener("click", async () => {
  try {
    const settings = await getSettings();
    const stream = await getTabStream(settings);
    await begin(stream, settings);
  } catch (err) {
    showError(err.message || String(err));
  }
});

shareBtn.addEventListener("click", async () => {
  try {
    const settings = await getSettings();
    const stream = await getDisplayStream();
    await begin(stream, settings);
  } catch (err) {
    showError(err.message || String(err));
  }
});

stopBtn.addEventListener("click", stop);

function ingestPointer(msg) {
  if (!recording || msg?.type !== "pointer") return;
  const wall = Number(msg.at);
  let t = Number.isFinite(wall) && recOriginWall
    ? (wall - recOriginWall) / 1000
    : (performance.now() - recOrigin) / 1000;
  if (!Number.isFinite(t)) t = (performance.now() - recOrigin) / 1000;
  t = Math.max(0, t);
  const x = Math.min(1, Math.max(0, Number(msg.x) || 0));
  const y = Math.min(1, Math.max(0, Number(msg.y) || 0));
  const last = samples[samples.length - 1];
  if (!last || t - last.t >= 0.008 || msg.click || msg.kind) {
    samples.push({ t, x, y, down: Boolean(msg.down) });
  } else {
    last.t = t;
    last.x = x;
    last.y = y;
    last.down = Boolean(msg.down);
  }
  if (msg.click && msg.button === 0) clicks.push({ t, x, y });
  if (msg.kind === "type") {
    focuses.push({
      t,
      x: msg.box?.x ?? x,
      y: msg.box?.y ?? y,
      w: msg.box?.w ?? 0.22,
      h: msg.box?.h ?? 0.06
    });
  }
  if (msg.kind === "scroll") scrolls.push({ t });
}

function connectPointerPort() {
  const port = chrome.runtime.connect({ name: "zinra-recorder" });
  port.onMessage.addListener(ingestPointer);
  port.onDisconnect.addListener(() => setTimeout(connectPointerPort, 250));
}
connectPointerPort();

chrome.runtime.onMessage.addListener((msg) => {
  ingestPointer(msg);
  if (msg.type === "recorder-stop") stop();
});

window.addEventListener("beforeunload", () => {
  if (recording && recorder && recorder.state === "recording") recorder.stop();
});

(async function start() {
  if (captureMode === "screen") {
    try {
      const prep = await chrome.runtime.sendMessage({ type: "prepare-desktop" });
      if (prep?.ok && prep.streamId) {
        const settings = await getSettings();
        const stream = await getDesktopStream(prep.streamId, settings.includeAudio);
        await begin(stream, settings);
        return;
      }
      // The popup's own picker (chrome.desktopCapture) either wasn't called,
      // was cancelled, or lost its user-gesture window before this tab could
      // ask for the result. Not a crash - just means there's no stream id to
      // reuse, so fall back to picking here. Logged so a real failure here
      // is diagnosable from this tab's console instead of looking identical
      // to a normal first run.
      console.warn("Zinra: no reusable desktop stream from the popup picker, falling back to manual share.", prep);
    } catch (err) {
      showScreenModeStart();
      showError(err.message || "Could not use that share. Click Share your screen to pick again.");
      return;
    }
    showScreenModeStart();
    return;
  }
  const fallback = window.setTimeout(() => {
    if (recording) return;
    startBtn.classList.remove("hidden");
    shareBtn.classList.remove("hidden");
    hint.textContent = "Still starting capture… click Start recording, or Share tab.";
  }, 2500);
  try {
    const settings = await getSettings();
    const stream = await getTabStream(settings);
    await begin(stream, settings);
  } catch (err) {
    showManualStart(err.message || "Tab capture failed.");
  } finally {
    window.clearTimeout(fallback);
  }
})();
