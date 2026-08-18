import {
  cameraAt,
  drawFrame,
  drawCursorGlyph,
  drawClickEffect,
  activeClickEffects,
  samplePointer,
  sourceFromCanvasPoint,
  resetCameraCache
} from "./compositor.js";
import { autoZoomClips } from "./camera-path.js";
import { resolveExportSize } from "./encode.js";
import { renderOfflineExport } from "./export-render.js";
import { isProLocked, CURSOR_STYLES, CLICK_EFFECTS, canExport, remainingFreeExports } from "./settings.js";

const DEPTH_PRESETS = {
  shallow: 1.25,
  moderate: 1.5,
  deep: 2.2,
  maximum: 3.0
};

const ASPECT_RATIOS = {
  original: null,
  "16:9": 16 / 9,
  "9:16": 9 / 16,
  "1:1": 1,
  "4:5": 4 / 5
};

// Largest centered rect of `ratio` (w/h) that fits inside the source frame,
// normalized to [0,1] so it composes with samples/clicks (also full-source).
function cropForAspect(ratio, srcW, srcH) {
  if (!ratio || !srcW || !srcH) return { x: 0, y: 0, w: 1, h: 1 };
  const srcRatio = srcW / srcH;
  let w, h;
  if (ratio > srcRatio) {
    w = 1;
    h = (srcW / ratio) / srcH;
  } else {
    h = 1;
    w = (srcH * ratio) / srcW;
  }
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

function depthFromSelect(value) {
  if (value === "custom") return null;
  if (DEPTH_PRESETS[value]) return DEPTH_PRESETS[value];
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 1) return numeric;
  return DEPTH_PRESETS.maximum;
}

function depthKeyForZoom(zoom) {
  let bestKey = "custom";
  let bestDiff = 0.05;
  for (const [key, amount] of Object.entries(DEPTH_PRESETS)) {
    const diff = Math.abs(amount - zoom);
    if (diff < bestDiff) {
      bestKey = key;
      bestDiff = diff;
    }
  }
  return bestKey;
}

function formatClock(seconds) {
  const total = Math.max(0, seconds);
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(Math.floor(total % 60)).padStart(2, "0");
  const cs = String(Math.floor((total % 1) * 100)).padStart(2, "0");
  return `${m}:${s}.${cs}`;
}

function uid() {
  return `z${Math.random().toString(36).slice(2, 8)}`;
}

function clampRange(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function isFiniteDuration(value) {
  return Number.isFinite(value) && value > 0 && value < 60 * 60 * 12;
}

function wait(eventTarget, eventName, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    eventTarget.addEventListener(eventName, () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function attachStepper(input, { step = 0.05, min = 0, max = Infinity } = {}) {
  if (!input || input.dataset.stepped) return;
  input.dataset.stepped = "1";
  const wrap = document.createElement("div");
  wrap.className = "numstep";
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);

  function bump(delta) {
    const cur = Number(input.value) || 0;
    const stepped = Math.round((cur + delta) / step) * step;
    input.value = clampRange(stepped, min, max).toFixed(2);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function addRepeatingButton(dir, delta) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `numstep-btn ${dir}`;
    btn.tabIndex = -1;
    btn.setAttribute("aria-label", delta > 0 ? "Increase" : "Decrease");
    let holdTimeout = null;
    let holdInterval = null;
    const stop = () => {
      clearTimeout(holdTimeout);
      clearInterval(holdInterval);
      holdTimeout = null;
      holdInterval = null;
    };
    btn.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      bump(delta);
      holdTimeout = setTimeout(() => {
        holdInterval = setInterval(() => bump(delta), 70);
      }, 380);
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => btn.addEventListener(ev, stop));
    wrap.appendChild(btn);
  }

  addRepeatingButton("up", step);
  addRepeatingButton("down", -step);
}

// Lemon Squeezy's License API: activating ties the key to this browser
// install (an "instance") and confirms it's a real, unused/valid key.
async function activateLicense(key) {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("Enter a license key.");
  let res;
  try {
    res = await fetch("https://api.lemonsqueezy.com/v1/licenses/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ license_key: trimmed, instance_name: "Zinra Chrome Extension" })
    });
  } catch {
    throw new Error("Could not reach the license server. Check your connection.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.activated) {
    throw new Error(data.error || "That license key didn't work. Check it and try again.");
  }
  return { key: trimmed, instanceId: data.instance?.id || null };
}

async function decodeAudioFile(file) {
  const ab = await file.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  try {
    return await ctx.decodeAudioData(ab);
  } finally {
    try { ctx.close(); } catch { /* ignore */ }
  }
}

async function resolveDuration(video, fallback) {
  try {
    await wait(video, "loadedmetadata", 4000);
  } catch {
    // Metadata can be missing on MediaRecorder WebM files.
  }
  if (isFiniteDuration(video.duration)) return video.duration;
  try {
    video.currentTime = 1e10;
    await wait(video, "seeked", 2000);
  } catch {
    // Seek-to-end is the usual Chrome workaround.
  }
  if (isFiniteDuration(video.duration)) return video.duration;
  if (isFiniteDuration(video.currentTime)) return video.currentTime;
  return Math.max(fallback, 0.5);
}

export function openEditor({ blob, samples, clicks, focuses = [], scrolls = [], settings, recordedSeconds = 1, capture = {}, audioBlob = null }) {
  const qs = (id) => document.getElementById(id);
  const recordView = qs("recordView");
  const editView = qs("editView");
  const canvas = qs("editCanvas");
  const video = qs("sourceVideo");
  const playBtn = qs("playBtn");
  const timeLabel = qs("timeLabel");
  const timelineScroll = qs("timelineScroll");
  const timelineInner = qs("timelineInner");
  const ruler = qs("ruler");
  const videoTrack = qs("videoTrack");
  const videoClip = qs("videoClip");
  const zoomTrack = qs("zoomTrack");
  const speedTrack = qs("speedTrack");
  const cutTrack = qs("cutTrack");
  const audioTrack = qs("audioTrack");
  const stageFrame = qs("stageFrame");
  const playhead = qs("playhead");
  const ctx = canvas.getContext("2d", { alpha: false, colorSpace: "srgb" });

  attachStepper(qs("clipStart"), { step: 0.05, min: 0 });
  attachStepper(qs("clipDuration"), { step: 0.05, min: 0.2 });
  attachStepper(qs("speedStart"), { step: 0.05, min: 0 });
  attachStepper(qs("speedDuration"), { step: 0.05, min: 0.1 });
  attachStepper(qs("cutStart"), { step: 0.05, min: 0 });
  attachStepper(qs("cutDuration"), { step: 0.05, min: 0.1 });
  attachStepper(qs("trimStart"), { step: 0.05, min: 0 });
  attachStepper(qs("trimEnd"), { step: 0.05, min: 0 });
  attachStepper(qs("audioStart"), { step: 0.05, min: 0 });
  attachStepper(qs("audioDuration"), { step: 0.05, min: 0.2 });

  document.body.classList.add("editor-body");
  document.title = "Zinra · Editor";
  recordView.classList.add("hidden");
  editView.classList.remove("hidden");
  chrome.runtime.sendMessage({ type: "enter-editor" }).catch(() => {});

  const defaultZoom = Number(settings.clickZoom) || 1.5;
  const defaultDuration = Number(settings.zoomDuration) || 2.2;

  function pathOptions() {
    return {
      restZoom: 1,
      clickZoom: defaultZoom,
      tightZoom: Math.min(1.85, defaultZoom + 0.25),
      clipHold: defaultDuration
    };
  }

  function cameraOptions(preview = true) {
    return {
      smooth: qs("smoothMove")?.checked !== false,
      alwaysFollow: qs("alwaysFollow")?.checked !== false,
      cameraTau: Number(qs("followLag")?.value) || 0.28,
      cursorTau: 0.08,
      selectedId: preview ? selectedId : null
    };
  }

  let clips = settings.autoMarkClicks === false
    ? []
    : autoZoomClips(samples, clicks, { focuses, scrolls }, pathOptions());
  let selectedId = clips[0]?.id || null;
  let speeds = [];
  let selectedSpeedId = null;
  let cuts = [];
  let selectedCutId = null;
  let audioTracks = [];
  let selectedAudioId = null;
  let cursorStyle = CURSOR_STYLES[settings.cursorStyle] ? settings.cursorStyle : "none";
  let cursorColor = /^#[0-9a-f]{6}$/i.test(settings.cursorColor || "") ? settings.cursorColor : "#e0b44a";
  let clickEffectStyle = CLICK_EFFECTS[settings.clickEffect] ? settings.clickEffect : "none";
  let crop = { x: 0, y: 0, w: 1, h: 1 };
  let cropDrag = null;
  let duration = 0;
  let trimStart = 0;
  let trimEnd = 0;
  let pps = 80;
  let fitMode = true;
  let zoomDirty = false;
  let speedDirty = false;
  let cutDirty = false;
  let trimDirty = false;
  let audioDirty = false;
  let exporting = false;
  let drag = null;
  let panel = "zoom";

  function clipMinPx() {
    return fitMode ? 2 : 20;
  }

  function labelsWidth() {
    const labels = timelineScroll.querySelector(".timeline-labels");
    return labels?.offsetWidth || 84;
  }

  function availableTimelineWidth() {
    return Math.max(120, timelineScroll.clientWidth - labelsWidth());
  }

  function rulerStep(pixelsPerSecond) {
    if (pixelsPerSecond > 140) return 1;
    if (pixelsPerSecond > 70) return 2;
    if (pixelsPerSecond > 28) return 5;
    if (pixelsPerSecond > 12) return 10;
    if (pixelsPerSecond > 5) return 30;
    return 60;
  }

  function setDirty(kind, on) {
    if (kind === "zoom") {
      zoomDirty = on;
      const btn = qs("saveZoomBtn");
      if (btn) btn.disabled = !on;
    } else if (kind === "speed") {
      speedDirty = on;
      const btn = qs("saveSpeedBtn");
      if (btn) btn.disabled = !on;
    } else if (kind === "cut") {
      cutDirty = on;
      const btn = qs("saveCutBtn");
      if (btn) btn.disabled = !on;
    } else if (kind === "trim") {
      trimDirty = on;
      const btn = qs("saveTrimBtn");
      if (btn) btn.disabled = !on;
    } else if (kind === "audio") {
      audioDirty = on;
      const btn = qs("saveAudioBtn");
      if (btn) btn.disabled = !on;
    }
    const hint = qs(`${kind}SaveHint`);
    if (hint) hint.textContent = on ? "Unsaved changes" : hint.textContent === "Saved" ? "Saved" : "";
  }

  function dirtyFor(kind) {
    if (kind === "zoom") return zoomDirty;
    if (kind === "speed") return speedDirty;
    if (kind === "cut") return cutDirty;
    if (kind === "audio") return audioDirty;
    return trimDirty;
  }

  function flashSaved(kind) {
    const hint = qs(`${kind}SaveHint`);
    if (hint) {
      hint.textContent = "Saved";
      setTimeout(() => {
        if (!dirtyFor(kind) && hint.textContent === "Saved") hint.textContent = "";
      }, 1400);
    }
  }

  function flashRemoved(kind) {
    const hint = qs(`${kind}SaveHint`);
    if (hint) {
      hint.textContent = "Deleted";
      setTimeout(() => {
        if (!dirtyFor(kind) && hint.textContent === "Deleted") hint.textContent = "";
      }, 1400);
    }
  }

  // A time range that should never appear in playback or export - what
  // makes cut segments actually *cut* instead of just being markers.
  function segAt(list, t) {
    for (const seg of list) {
      if (seg.enabled === false) continue;
      if (t >= seg.start && t < seg.start + seg.duration) return seg;
    }
    return null;
  }

  function skipCuts(t) {
    const cut = segAt(cuts, t);
    return cut ? cut.start + cut.duration : t;
  }

  function speedAt(t) {
    const seg = segAt(speeds, t);
    return seg ? Number(seg.multiplier) || 1 : 1;
  }

  const speedTrackDesc = {
    getList: () => speeds,
    trackEl: speedTrack,
    className: "speed-seg",
    defaultDuration: 1.5,
    minDuration: 0.1,
    extra: () => ({ multiplier: 1 }),
    label: (seg) => `${Number(seg.multiplier || 1).toFixed(2).replace(/\.?0+$/, "")}×`,
    getSelected: () => selectedSpeedId,
    setSelected: (id) => {
      if (selectedSpeedId && selectedSpeedId !== id && speedDirty) saveSpeedSegment();
      selectedSpeedId = id;
    },
    syncPanel: () => syncSpeedInspector()
  };

  const cutTrackDesc = {
    getList: () => cuts,
    trackEl: cutTrack,
    className: "cut-seg",
    defaultDuration: 1,
    minDuration: 0.1,
    extra: () => ({}),
    label: () => "✂",
    getSelected: () => selectedCutId,
    setSelected: (id) => {
      if (selectedCutId && selectedCutId !== id && cutDirty) saveCutSegment();
      selectedCutId = id;
    },
    syncPanel: () => syncCutInspector()
  };

  const audioTrackDesc = {
    getList: () => audioTracks,
    trackEl: audioTrack,
    className: "audio-seg",
    defaultDuration: 3,
    minDuration: 0.2,
    extra: () => ({}),
    label: (seg) => (seg.name || "Audio").replace(/\.[^./]+$/, ""),
    getSelected: () => selectedAudioId,
    setSelected: (id) => {
      if (selectedAudioId && selectedAudioId !== id && audioDirty) saveAudioSegment();
      selectedAudioId = id;
    },
    syncPanel: () => syncAudioInspector()
  };

  function segKindOf(d) {
    if (d === speedTrackDesc) return "speed";
    if (d === cutTrackDesc) return "cut";
    return "audio";
  }

  function removeSegment(kind, id) {
    if (!id) return;
    if (kind === "zoom") {
      clips = clips.filter((c) => c.id !== id);
      selectedId = clips[0]?.id || null;
      paintClips();
    } else {
      const d = kind === "speed" ? speedTrackDesc : kind === "cut" ? cutTrackDesc : audioTrackDesc;
      const list = d.getList();
      const idx = list.findIndex((s) => s.id === id);
      if (idx === -1) return;
      if (kind === "audio") {
        const seg = list[idx];
        try { seg._el?.pause(); if (seg._el) URL.revokeObjectURL(seg._el.src); } catch { /* ignore */ }
      }
      list.splice(idx, 1);
      if (d.getSelected() === id) {
        if (kind === "speed") selectedSpeedId = list[0]?.id || null;
        else if (kind === "cut") selectedCutId = list[0]?.id || null;
        else selectedAudioId = list[0]?.id || null;
      }
      paintSeg(d);
    }
    flashRemoved(kind);
    render();
  }

  function paintSeg(d) {
    d.trackEl.querySelectorAll(`.${d.className}`).forEach((el) => el.remove());
    for (const seg of d.getList()) {
      const el = document.createElement("div");
      el.className = `${d.className}${seg.id === d.getSelected() ? " selected" : ""}${seg.enabled === false ? " disabled" : ""}${seg.muted ? " muted" : ""}`;
      el.style.left = `${seg.start * pps}px`;
      el.style.width = `${Math.max(clipMinPx(), seg.duration * pps)}px`;
      el.dataset.id = seg.id;
      el.innerHTML = `
        <span class="trim-handle left" data-mode="start"></span>
        <span class="zoom-clip-label">${d.label(seg)}</span>
        <span class="seg-remove" title="Delete">×</span>
        <span class="trim-handle right" data-mode="end"></span>
      `;
      el.addEventListener("pointerdown", (event) => onSegPointerDown(event, seg, d));
      const removeBtn = el.querySelector(".seg-remove");
      removeBtn.addEventListener("pointerdown", (event) => event.stopPropagation());
      removeBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        removeSegment(segKindOf(d), seg.id);
      });
      d.trackEl.appendChild(el);
    }
    d.syncPanel();
  }

  function placeSeg(d, seg) {
    const el = d.trackEl.querySelector(`[data-id="${seg.id}"]`);
    if (!el) return;
    el.style.left = `${seg.start * pps}px`;
    el.style.width = `${Math.max(clipMinPx(), seg.duration * pps)}px`;
  }

  function addSeg(d, time, length) {
    const start = clampRange(time, 0, Math.max(0, duration - d.minDuration));
    const seg = {
      id: uid(),
      start,
      duration: clampRange(length ?? d.defaultDuration, d.minDuration, Math.max(d.minDuration, duration - start)),
      enabled: true,
      ...d.extra()
    };
    const list = d.getList();
    list.push(seg);
    list.sort((a, b) => a.start - b.start);
    d.setSelected(seg.id);
    showPanel(d === speedTrackDesc ? "speed" : "cut");
    paintSeg(d);
    render();
    return seg;
  }

  function applySegDrag(event) {
    const d = drag.track;
    const seg = d.getList().find((item) => item.id === drag.id);
    if (!seg) return;
    const time = timeFromClientX(event.clientX);
    const isAudio = seg.fileOffset !== undefined;
    if (drag.mode === "move") {
      const delta = (event.clientX - drag.originX) / pps;
      seg.start = clampRange(drag.start + delta, 0, Math.max(0, duration - seg.duration));
      video.currentTime = seg.start;
    } else if (drag.mode === "start") {
      if (isAudio) {
        // Left handle trims into the source file - can't reach before its own start.
        const delta = clampRange(time - drag.originTime, -drag.fileOffset, drag.duration - d.minDuration);
        seg.start = drag.start + delta;
        seg.fileOffset = drag.fileOffset + delta;
        seg.duration = (drag.start + drag.duration) - seg.start;
      } else {
        const end = drag.start + drag.duration;
        seg.start = clampRange(time, 0, end - d.minDuration);
        seg.duration = end - seg.start;
      }
      video.currentTime = seg.start;
    } else if (drag.mode === "end") {
      if (isAudio) {
        const maxDuration = Math.max(d.minDuration, Math.min(seg.bufferDuration - seg.fileOffset, duration - seg.start));
        seg.duration = clampRange(time - seg.start, d.minDuration, maxDuration);
      } else {
        seg.duration = clampRange(time - seg.start, d.minDuration, duration - seg.start);
      }
      video.currentTime = Math.min(duration, seg.start + seg.duration);
    } else if (drag.mode === "create") {
      const origin = drag.originTime;
      seg.start = Math.min(origin, time);
      seg.duration = Math.max(d.minDuration, Math.abs(time - origin));
      if (seg.start + seg.duration > duration) seg.duration = duration - seg.start;
      video.currentTime = time;
    }
    placeSeg(d, seg);
    render();
  }

  function onSegPointerDown(event, seg, d) {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.target.closest(".trim-handle");
    d.setSelected(seg.id);
    showPanel(d === speedTrackDesc ? "speed" : "cut");
    d.trackEl.querySelectorAll(`.${d.className}`).forEach((el) => {
      el.classList.toggle("selected", el.dataset.id === seg.id);
    });
    drag = {
      kind: "seg",
      track: d,
      mode: handle?.dataset.mode || "move",
      id: seg.id,
      originX: event.clientX,
      originTime: timeFromClientX(event.clientX),
      start: seg.start,
      duration: seg.duration,
      fileOffset: seg.fileOffset
    };
    event.currentTarget.classList.add("dragging");
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragUp);
  }

  const loadStatus = qs("loadStatus");
  video.src = URL.createObjectURL(blob);
  video.muted = true;

  video.addEventListener("loadedmetadata", () => {
    if (video.videoWidth && video.videoHeight) {
      video.width = video.videoWidth;
      video.height = video.videoHeight;
    }
  });
  video.addEventListener("error", () => {
    if (loadStatus) loadStatus.textContent = "Could not decode this recording. Try Share tab next time, then Stop & edit again.";
  });

  function selected() {
    return clips.find((clip) => clip.id === selectedId) || null;
  }

  function currentTime() {
    return video.currentTime || 0;
  }

  function showPanel(name) {
    panel = name;
    qs("tabZoom").classList.toggle("active", name === "zoom");
    qs("tabSpeed").classList.toggle("active", name === "speed");
    qs("tabCut").classList.toggle("active", name === "cut");
    qs("tabAudio").classList.toggle("active", name === "audio");
    qs("tabCursor").classList.toggle("active", name === "cursor");
    qs("tabCrop").classList.toggle("active", name === "crop");
    qs("tabTrim").classList.toggle("active", name === "trim");
    qs("panelZoom").classList.toggle("hidden", name !== "zoom");
    qs("panelSpeed").classList.toggle("hidden", name !== "speed");
    qs("panelCut").classList.toggle("hidden", name !== "cut");
    qs("panelAudio").classList.toggle("hidden", name !== "audio");
    qs("panelCursor").classList.toggle("hidden", name !== "cursor");
    qs("panelCrop").classList.toggle("hidden", name !== "crop");
    qs("panelTrim").classList.toggle("hidden", name !== "trim");
  }

  function render() {
    if (!duration || exporting) return;
    const t = currentTime();
    if (!video.paused && !exporting) {
      video.playbackRate = speedAt(t);
      const skipped = skipCuts(t);
      if (skipped > t + 0.001) {
        if (skipped >= trimEnd - 0.02) {
          video.pause();
          video.currentTime = trimEnd;
        } else {
          video.currentTime = skipped;
        }
      } else if (t >= trimEnd - 0.02) {
        video.pause();
        video.currentTime = trimEnd;
      }
    }
    const camera = cameraAt(t, clips, samples, cameraOptions());
    const clip = selected();
    drawFrame(ctx, video, camera, {
      crop,
      cursor: cursorStyle !== "none" ? { style: cursorStyle, color: cursorColor, ...samplePointer(samples, t) } : null,
      clickEffects: clickEffectStyle !== "none" ? activeClickEffects(clicks, t) : null,
      clickStyle: clickEffectStyle,
      clickColor: cursorColor,
      focusGuide: !exporting && clip && clip.followCursor === false ? { x: clip.x, y: clip.y } : null
    });
    syncAudioPreview(t);
    playhead.style.left = `${t * pps}px`;
    timeLabel.textContent = `${formatClock(t)} / ${formatClock(duration)}`;
  }

  // Keeps imported audio tracks audible in the live editor preview, mirroring
  // the main video's play state and seeking only when drift is audible.
  function syncAudioPreview(t) {
    const playing = !video.paused && !exporting;
    for (const seg of audioTracks) {
      const active = seg.enabled !== false && !seg.muted && t >= seg.start && t < seg.start + seg.duration;
      if (!active) {
        if (seg._el && !seg._el.paused) seg._el.pause();
        continue;
      }
      if (!seg._el) {
        seg._el = new Audio();
        seg._el.src = URL.createObjectURL(seg.file);
        seg._el.preload = "auto";
      }
      const target = seg.fileOffset + (t - seg.start);
      if (Math.abs(seg._el.currentTime - target) > 0.15) {
        try { seg._el.currentTime = target; } catch { /* not seekable yet */ }
      }
      seg._el.volume = clampRange(Number(seg.volume) || 1, 0, 1);
      if (playing && seg._el.paused) seg._el.play().catch(() => {});
      if (!playing && !seg._el.paused) seg._el.pause();
    }
  }

  function pauseAudioPreviews() {
    for (const seg of audioTracks) {
      try { seg._el?.pause(); } catch { /* ignore */ }
    }
  }

  function layoutTimeline() {
    if (!Number.isFinite(duration) || duration <= 0) return;
    const avail = availableTimelineWidth();
    if (fitMode) pps = avail / Math.max(duration, 0.1);
    const width = fitMode ? avail : Math.max(duration * pps, avail);
    timelineInner.style.width = `${width}px`;
    timelineScroll.style.overflowX = !fitMode && duration * pps > avail + 1 ? "auto" : "hidden";
    ruler.innerHTML = "";
    const step = rulerStep(pps);
    for (let t = 0; t <= duration; t += step) {
      const mark = document.createElement("span");
      mark.className = "ruler-mark";
      mark.style.left = `${t * pps}px`;
      mark.textContent = formatClock(t).slice(0, 5);
      ruler.appendChild(mark);
    }
    videoClip.style.left = `${trimStart * pps}px`;
    videoClip.style.width = `${Math.max(clipMinPx(), (trimEnd - trimStart) * pps)}px`;
    paintClips();
    paintSeg(speedTrackDesc);
    paintSeg(cutTrackDesc);
    paintSeg(audioTrackDesc);
    render();
  }

  function paintClips() {
    zoomTrack.querySelectorAll(".zoom-clip").forEach((el) => el.remove());
    for (const clip of clips) {
      const el = document.createElement("div");
      el.className = `zoom-clip${clip.id === selectedId ? " selected" : ""}${clip.enabled === false ? " disabled" : ""}`;
      el.style.left = `${clip.start * pps}px`;
      el.style.width = `${Math.max(clipMinPx(), clip.duration * pps)}px`;
      el.dataset.id = clip.id;
      el.innerHTML = `
        <span class="trim-handle left" data-mode="start"></span>
        <span class="zoom-clip-label">${Number(clip.zoom || DEPTH_PRESETS.moderate).toFixed(1)}×</span>
        <span class="seg-remove" title="Delete">×</span>
        <span class="trim-handle right" data-mode="end"></span>
      `;
      el.addEventListener("pointerdown", (event) => onClipPointerDown(event, clip));
      const removeBtn = el.querySelector(".seg-remove");
      removeBtn.addEventListener("pointerdown", (event) => event.stopPropagation());
      removeBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        removeSegment("zoom", clip.id);
      });
      zoomTrack.appendChild(el);
    }
    syncInspector();
  }

  function syncInspector() {
    const clip = selected();
    qs("zoomEmpty").classList.toggle("hidden", Boolean(clip));
    qs("zoomControls").classList.toggle("hidden", !clip);
    if (!clip) return;
    qs("zoomEnabled").checked = clip.enabled !== false;
    if (!Number.isFinite(clip.zoom) || clip.zoom < 1) clip.zoom = DEPTH_PRESETS.moderate;
    const key = depthKeyForZoom(clip.zoom);
    qs("zoomDepth").value = key;
    qs("clipZoom").value = clip.zoom;
    qs("clipZoomVal").textContent = `${clip.zoom.toFixed(2)}×`;
    qs("zoomFollow").value = clip.followCursor === false ? "fixed" : "follow";
    if (!zoomDirty) {
      qs("clipStart").value = clip.start.toFixed(2);
      qs("clipDuration").value = clip.duration.toFixed(2);
    }
    qs("trimStart").value = trimStart.toFixed(2);
    qs("trimEnd").value = trimEnd.toFixed(2);
  }

  function syncSpeedInspector() {
    const seg = speeds.find((s) => s.id === selectedSpeedId) || null;
    qs("speedEmpty").classList.toggle("hidden", Boolean(seg));
    qs("speedControls").classList.toggle("hidden", !seg);
    if (!seg) return;
    qs("speedEnabled").checked = seg.enabled !== false;
    qs("speedMultiplier").value = String(Number(seg.multiplier) || 1);
    if (!speedDirty) {
      qs("speedStart").value = seg.start.toFixed(2);
      qs("speedDuration").value = seg.duration.toFixed(2);
    }
  }

  function syncCutInspector() {
    const seg = cuts.find((s) => s.id === selectedCutId) || null;
    qs("cutEmpty").classList.toggle("hidden", Boolean(seg));
    qs("cutControls").classList.toggle("hidden", !seg);
    const removed = cuts.reduce((sum, c) => sum + (c.enabled === false ? 0 : c.duration), 0);
    const summary = qs("cutSummary");
    if (summary) {
      summary.textContent = removed > 0.01
        ? `${cuts.filter((c) => c.enabled !== false).length} cut(s) removing ${removed.toFixed(1)}s - final export will be about ${formatClock(Math.max(0, (trimEnd - trimStart) - removed))} long.`
        : "";
    }
    if (!seg) return;
    qs("cutEnabled").checked = seg.enabled !== false;
    if (!cutDirty) {
      qs("cutStart").value = seg.start.toFixed(2);
      qs("cutDuration").value = seg.duration.toFixed(2);
    }
  }

  function syncAudioInspector() {
    const seg = audioTracks.find((s) => s.id === selectedAudioId) || null;
    qs("audioEmpty").classList.toggle("hidden", Boolean(seg));
    qs("audioControls").classList.toggle("hidden", !seg);
    if (!seg) return;
    qs("audioEnabled").checked = seg.enabled !== false;
    qs("audioMuted").checked = Boolean(seg.muted);
    qs("audioFileName").textContent = seg.name || "";
    const vol = Number(seg.volume ?? 1);
    qs("audioVolume").value = String(vol);
    qs("audioVolumeVal").textContent = `${Math.round(vol * 100)}%`;
    if (!audioDirty) {
      qs("audioStart").value = seg.start.toFixed(2);
      qs("audioDuration").value = seg.duration.toFixed(2);
    }
  }

  function saveZoomSegment(target = selected(), { paint = true } = {}) {
    const clip = target;
    if (!clip) return;
    clip.enabled = qs("zoomEnabled").checked;
    const preset = depthFromSelect(qs("zoomDepth").value);
    clip.zoom = preset != null ? preset : Number(qs("clipZoom").value);
    clip.followCursor = qs("zoomFollow").value === "follow";
    clip.start = clampRange(Number(qs("clipStart").value) || 0, 0, Math.max(0, duration - 0.2));
    clip.duration = clampRange(Number(qs("clipDuration").value) || 0.2, 0.2, Math.max(0.2, duration - clip.start));
    if (!clip.followCursor) {
      const pointer = samplePointer(samples, currentTime());
      if (!Number.isFinite(clip.x) || !Number.isFinite(clip.y)) {
        clip.x = pointer.x;
        clip.y = pointer.y;
      }
    }
    setDirty("zoom", false);
    flashSaved("zoom");
    if (paint) paintClips();
    render();
  }

  function saveSpeedSegment() {
    const seg = speeds.find((s) => s.id === selectedSpeedId);
    if (!seg) return;
    seg.enabled = qs("speedEnabled").checked;
    seg.multiplier = Number(qs("speedMultiplier").value) || 1;
    seg.start = clampRange(Number(qs("speedStart").value) || 0, 0, Math.max(0, duration - speedTrackDesc.minDuration));
    seg.duration = clampRange(
      Number(qs("speedDuration").value) || speedTrackDesc.minDuration,
      speedTrackDesc.minDuration,
      Math.max(speedTrackDesc.minDuration, duration - seg.start)
    );
    setDirty("speed", false);
    flashSaved("speed");
    paintSeg(speedTrackDesc);
    render();
  }

  function saveCutSegment() {
    const seg = cuts.find((s) => s.id === selectedCutId);
    if (!seg) return;
    seg.enabled = qs("cutEnabled").checked;
    seg.start = clampRange(Number(qs("cutStart").value) || 0, 0, Math.max(0, duration - cutTrackDesc.minDuration));
    seg.duration = clampRange(
      Number(qs("cutDuration").value) || cutTrackDesc.minDuration,
      cutTrackDesc.minDuration,
      Math.max(cutTrackDesc.minDuration, duration - seg.start)
    );
    setDirty("cut", false);
    flashSaved("cut");
    paintSeg(cutTrackDesc);
    render();
  }

  function saveAudioSegment() {
    const seg = audioTracks.find((s) => s.id === selectedAudioId);
    if (!seg) return;
    seg.enabled = qs("audioEnabled").checked;
    seg.muted = qs("audioMuted").checked;
    seg.volume = clampRange(Number(qs("audioVolume").value) || 1, 0, 1.5);
    seg.start = clampRange(Number(qs("audioStart").value) || 0, 0, Math.max(0, duration - audioTrackDesc.minDuration));
    const maxDuration = Math.max(audioTrackDesc.minDuration, Math.min(seg.bufferDuration - seg.fileOffset, duration - seg.start));
    seg.duration = clampRange(Number(qs("audioDuration").value) || audioTrackDesc.minDuration, audioTrackDesc.minDuration, maxDuration);
    setDirty("audio", false);
    flashSaved("audio");
    paintSeg(audioTrackDesc);
    render();
  }

  function saveTrim() {
    trimStart = clampRange(Number(qs("trimStart").value) || 0, 0, Math.max(0, duration - 0.2));
    trimEnd = clampRange(Number(qs("trimEnd").value) || duration, trimStart + 0.2, duration);
    setDirty("trim", false);
    flashSaved("trim");
    layoutTimeline();
  }

  function selectClip(id) {
    if (selectedId && selectedId !== id && zoomDirty) {
      saveZoomSegment(clips.find((item) => item.id === selectedId), { paint: false });
    }
    selectedId = id;
    if (id) showPanel("zoom");
    paintClips();
    render();
  }

  function addZoomAt(time, length) {
    const start = clampRange(time, 0, Math.max(0, duration - 0.2));
    const pointer = samplePointer(samples, start);
    const clip = {
      id: uid(),
      start,
      duration: clampRange(length ?? defaultDuration, 0.2, Math.max(0.2, duration - start)),
      zoom: Number.isFinite(defaultZoom) ? defaultZoom : DEPTH_PRESETS.moderate,
      x: pointer.x,
      y: pointer.y,
      followCursor: true,
      enabled: true
    };
    clips.push(clip);
    clips.sort((a, b) => a.start - b.start);
    selectedId = clip.id;
    showPanel("zoom");
    paintClips();
    render();
    return clip;
  }

  function timeFromClientX(clientX) {
    const rect = timelineInner.getBoundingClientRect();
    return clampRange((clientX - rect.left) / pps, 0, duration);
  }

  function placeClipEl(clip) {
    const block = zoomTrack.querySelector(`[data-id="${clip.id}"]`);
    if (!block) return;
    block.style.left = `${clip.start * pps}px`;
    block.style.width = `${Math.max(clipMinPx(), clip.duration * pps)}px`;
  }

  function applyZoomDrag(event) {
    const clip = clips.find((item) => item.id === drag.id);
    if (!clip) return;
    const time = timeFromClientX(event.clientX);
    if (drag.mode === "move") {
      const delta = (event.clientX - drag.originX) / pps;
      clip.start = clampRange(drag.start + delta, 0, Math.max(0, duration - clip.duration));
      video.currentTime = clip.start;
    } else if (drag.mode === "start") {
      const end = drag.start + drag.duration;
      clip.start = clampRange(time, 0, end - 0.2);
      clip.duration = end - clip.start;
      video.currentTime = clip.start;
    } else if (drag.mode === "end") {
      clip.duration = clampRange(time - clip.start, 0.2, duration - clip.start);
      video.currentTime = Math.min(duration, clip.start + clip.duration);
    } else if (drag.mode === "create") {
      const origin = drag.originTime;
      clip.start = Math.min(origin, time);
      clip.duration = Math.max(0.2, Math.abs(time - origin));
      if (clip.start + clip.duration > duration) clip.duration = duration - clip.start;
      video.currentTime = time;
    }
    placeClipEl(clip);
    syncInspector();
    render();
  }

  function onClipPointerDown(event, clip) {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.target.closest(".trim-handle");
    if (selectedId && selectedId !== clip.id && zoomDirty) {
      saveZoomSegment(clips.find((item) => item.id === selectedId), { paint: false });
    }
    selectedId = clip.id;
    showPanel("zoom");
    syncInspector();
    zoomTrack.querySelectorAll(".zoom-clip").forEach((el) => {
      el.classList.toggle("selected", el.dataset.id === clip.id);
    });
    drag = {
      kind: "zoom",
      mode: handle?.dataset.mode || "move",
      id: clip.id,
      originX: event.clientX,
      originTime: timeFromClientX(event.clientX),
      start: clip.start,
      duration: clip.duration
    };
    event.currentTarget.classList.add("dragging");
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragUp);
  }

  function onDragMove(event) {
    if (!drag) return;
    if (drag.kind === "create") {
      if (!drag.id && Math.abs(event.clientX - drag.originX) > 6) {
        const time = timeFromClientX(event.clientX);
        const clip = addZoomAt(Math.min(drag.originTime, time), Math.max(0.2, Math.abs(time - drag.originTime)));
        drag.id = clip.id;
        drag.kind = "zoom";
        drag.mode = "create";
        drag.start = clip.start;
        drag.duration = clip.duration;
      }
      if (drag.id) applyZoomDrag(event);
      return;
    }
    if (drag.kind === "zoom") applyZoomDrag(event);
    if (drag.kind === "trim") {
      const delta = (event.clientX - drag.originX) / pps;
      if (drag.mode === "start") trimStart = clampRange(drag.start + delta, 0, trimEnd - 0.2);
      else trimEnd = clampRange(drag.end + delta, trimStart + 0.2, duration);
      layoutTimeline();
    }
    if (drag.kind === "seg-create") {
      if (!drag.id && Math.abs(event.clientX - drag.originX) > 6) {
        const time = timeFromClientX(event.clientX);
        const seg = addSeg(drag.track, Math.min(drag.originTime, time), Math.max(drag.track.minDuration, Math.abs(time - drag.originTime)));
        drag.id = seg.id;
        drag.kind = "seg";
        drag.mode = "create";
        drag.start = seg.start;
        drag.duration = seg.duration;
      }
      if (drag.id) applySegDrag(event);
      return;
    }
    if (drag.kind === "seg") applySegDrag(event);
  }

  function onDragUp() {
    if (drag?.kind === "create" && !drag.id) addZoomAt(drag.originTime, defaultDuration);
    if (drag?.kind === "seg-create" && !drag.id) addSeg(drag.track, drag.originTime, drag.track.defaultDuration);
    const finishedTrack = drag?.track;
    drag = null;
    document.querySelectorAll(".zoom-clip.dragging, .speed-seg.dragging, .cut-seg.dragging").forEach((el) => el.classList.remove("dragging"));
    paintClips();
    if (finishedTrack) paintSeg(finishedTrack);
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", onDragUp);
  }

  zoomTrack.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".zoom-clip")) return;
    const t = timeFromClientX(event.clientX);
    video.currentTime = t;
    drag = {
      kind: "create",
      originX: event.clientX,
      originTime: t
    };
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragUp);
  });

  speedTrack.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".speed-seg")) return;
    const t = timeFromClientX(event.clientX);
    video.currentTime = t;
    drag = { kind: "seg-create", track: speedTrackDesc, originX: event.clientX, originTime: t };
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragUp);
  });

  cutTrack.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".cut-seg")) return;
    const t = timeFromClientX(event.clientX);
    video.currentTime = t;
    drag = { kind: "seg-create", track: cutTrackDesc, originX: event.clientX, originTime: t };
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragUp);
  });

  videoTrack.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".trim-handle")) return;
    const t = timeFromClientX(event.clientX);
    video.currentTime = t;
  });

  audioTrack.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".audio-seg")) return;
    const t = timeFromClientX(event.clientX);
    video.currentTime = t;
  });

  videoClip.querySelectorAll(".trim-handle").forEach((handle) => {
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      showPanel("trim");
      drag = {
        kind: "trim",
        mode: handle.dataset.trim,
        originX: event.clientX,
        start: trimStart,
        end: trimEnd
      };
      window.addEventListener("pointermove", onDragMove);
      window.addEventListener("pointerup", onDragUp);
    });
  });

  function onCropDragMove(event) {
    if (!cropDrag) return;
    const rect = canvas.getBoundingClientRect();
    const dxNorm = ((event.clientX - cropDrag.originX) * (canvas.width / Math.max(1, rect.width))) / (video.videoWidth || 1);
    const dyNorm = ((event.clientY - cropDrag.originY) * (canvas.height / Math.max(1, rect.height))) / (video.videoHeight || 1);
    // Drag the picture, not the frame: moving the pointer right reveals
    // content that was off-screen to the left, so crop.x moves the other way.
    crop.x = clampRange(cropDrag.startX - dxNorm, 0, Math.max(0, 1 - crop.w));
    crop.y = clampRange(cropDrag.startY - dyNorm, 0, Math.max(0, 1 - crop.h));
    render();
  }
  function onCropDragUp() {
    cropDrag = null;
    window.removeEventListener("pointermove", onCropDragMove);
    window.removeEventListener("pointerup", onCropDragUp);
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (panel === "crop") {
      if (crop.w >= 0.999 && crop.h >= 0.999) return;
      cropDrag = { originX: event.clientX, originY: event.clientY, startX: crop.x, startY: crop.y };
      window.addEventListener("pointermove", onCropDragMove);
      window.addEventListener("pointerup", onCropDragUp);
      return;
    }
    const clip = selected();
    if (!clip || clip.followCursor !== false) return;
    const point = sourceFromCanvasPoint(cameraAt(currentTime(), clips, samples, cameraOptions()), canvas, event.clientX, event.clientY, crop);
    clip.x = point.x;
    clip.y = point.y;
    render();
  });

  qs("tabZoom").addEventListener("click", () => showPanel("zoom"));
  qs("tabSpeed").addEventListener("click", () => showPanel("speed"));
  qs("tabCut").addEventListener("click", () => showPanel("cut"));
  qs("tabAudio").addEventListener("click", () => showPanel("audio"));
  qs("tabCursor").addEventListener("click", () => showPanel("cursor"));
  qs("tabCrop").addEventListener("click", () => showPanel("crop"));
  qs("tabTrim").addEventListener("click", () => showPanel("trim"));

  playBtn.addEventListener("click", async () => {
    if (exporting) return;
    if (video.paused) {
      if (currentTime() < trimStart || currentTime() >= trimEnd) video.currentTime = trimStart;
      video.playbackRate = speedAt(currentTime());
      await video.play();
    } else video.pause();
  });
  qs("backBtn").addEventListener("click", () => {
    video.currentTime = clampRange(currentTime() - 1, trimStart, trimEnd);
  });
  qs("fwdBtn").addEventListener("click", () => {
    video.currentTime = clampRange(currentTime() + 1, trimStart, trimEnd);
  });

  video.addEventListener("play", () => {
    if (exporting) return;
    const icon = playBtn.querySelector(".ui-icon");
    const label = playBtn.querySelector(".btn-label");
    if (icon) icon.src = "icons/svg/pause.svg";
    if (label) label.textContent = "Pause";
    playBtn.classList.add("is-playing");
  });
  video.addEventListener("pause", () => {
    if (exporting) return;
    const icon = playBtn.querySelector(".ui-icon");
    const label = playBtn.querySelector(".btn-label");
    if (icon) icon.src = "icons/svg/play.svg";
    if (label) label.textContent = "Play";
    playBtn.classList.remove("is-playing");
  });
  video.addEventListener("seeked", render);
  video.addEventListener("timeupdate", render);

  qs("addZoomBtn").addEventListener("click", () => addZoomAt(currentTime()));
  qs("rebuildZoomBtn")?.addEventListener("click", () => {
    clips = autoZoomClips(samples, clicks, { focuses, scrolls }, pathOptions());
    selectedId = clips[0]?.id || null;
    paintClips();
    render();
  });
  qs("deleteZoomBtn").addEventListener("click", () => {
    clips = clips.filter((clip) => clip.id !== selectedId);
    selectedId = clips[0]?.id || null;
    paintClips();
    render();
  });
  qs("splitBtn").addEventListener("click", () => {
    const clip = selected();
    const t = currentTime();
    if (!clip || t <= clip.start + 0.15 || t >= clip.start + clip.duration - 0.15) return;
    const leftDur = t - clip.start;
    const right = {
      ...clip,
      id: uid(),
      start: t,
      duration: clip.duration - leftDur
    };
    clip.duration = leftDur;
    clips.push(right);
    clips.sort((a, b) => a.start - b.start);
    selectClip(right.id);
  });
  qs("applyAllBtn").addEventListener("click", () => {
    const clip = selected();
    if (!clip) return;
    for (const item of clips) item.zoom = clip.zoom;
    paintClips();
    render();
  });
  qs("saveZoomBtn")?.addEventListener("click", saveZoomSegment);
  qs("saveSpeedBtn")?.addEventListener("click", saveSpeedSegment);
  qs("saveCutBtn")?.addEventListener("click", saveCutSegment);
  qs("saveTrimBtn")?.addEventListener("click", saveTrim);

  qs("zoomEnabled").addEventListener("change", () => {
    const clip = selected();
    if (!clip) return;
    clip.enabled = qs("zoomEnabled").checked;
    setDirty("zoom", true);
    paintClips();
    render();
  });
  qs("zoomDepth").addEventListener("change", () => {
    const clip = selected();
    if (!clip) return;
    const preset = depthFromSelect(qs("zoomDepth").value);
    if (preset != null) clip.zoom = preset;
    qs("clipZoom").value = clip.zoom;
    qs("clipZoomVal").textContent = `${clip.zoom.toFixed(2)}×`;
    setDirty("zoom", true);
    paintClips();
    render();
  });
  qs("clipZoom").addEventListener("input", () => {
    const clip = selected();
    if (!clip) return;
    clip.zoom = Number(qs("clipZoom").value);
    qs("clipZoomVal").textContent = `${clip.zoom.toFixed(2)}×`;
    qs("zoomDepth").value = "custom";
    setDirty("zoom", true);
    render();
  });
  qs("zoomFollow").addEventListener("change", () => {
    const clip = selected();
    if (!clip) return;
    clip.followCursor = qs("zoomFollow").value === "follow";
    if (!clip.followCursor) {
      const pointer = samplePointer(samples, currentTime());
      clip.x = pointer.x;
      clip.y = pointer.y;
    }
    resetCameraCache();
    setDirty("zoom", true);
    render();
  });
  qs("clipStart").addEventListener("input", () => setDirty("zoom", true));
  qs("clipDuration").addEventListener("input", () => setDirty("zoom", true));

  qs("addSpeedBtn").addEventListener("click", () => addSeg(speedTrackDesc, currentTime()));
  qs("deleteSpeedBtn").addEventListener("click", () => {
    speeds = speeds.filter((s) => s.id !== selectedSpeedId);
    selectedSpeedId = speeds[0]?.id || null;
    paintSeg(speedTrackDesc);
    render();
  });
  qs("speedEnabled").addEventListener("change", () => {
    const seg = speeds.find((s) => s.id === selectedSpeedId);
    if (!seg) return;
    seg.enabled = qs("speedEnabled").checked;
    setDirty("speed", true);
    paintSeg(speedTrackDesc);
    render();
  });
  qs("speedMultiplier").addEventListener("change", () => {
    const seg = speeds.find((s) => s.id === selectedSpeedId);
    if (!seg) return;
    seg.multiplier = Number(qs("speedMultiplier").value) || 1;
    setDirty("speed", true);
    paintSeg(speedTrackDesc);
    render();
  });
  qs("speedStart").addEventListener("input", () => setDirty("speed", true));
  qs("speedDuration").addEventListener("input", () => setDirty("speed", true));

  qs("addCutBtn").addEventListener("click", () => addSeg(cutTrackDesc, currentTime()));
  qs("deleteCutBtn").addEventListener("click", () => {
    cuts = cuts.filter((s) => s.id !== selectedCutId);
    selectedCutId = cuts[0]?.id || null;
    paintSeg(cutTrackDesc);
    render();
  });
  qs("cutEnabled").addEventListener("change", () => {
    const seg = cuts.find((s) => s.id === selectedCutId);
    if (!seg) return;
    seg.enabled = qs("cutEnabled").checked;
    setDirty("cut", true);
    paintSeg(cutTrackDesc);
    render();
  });
  qs("cutStart").addEventListener("input", () => setDirty("cut", true));
  qs("cutDuration").addEventListener("input", () => setDirty("cut", true));

  function openAudioPicker() {
    qs("audioFileInput").click();
  }
  qs("addAudioBtn").addEventListener("click", openAudioPicker);
  qs("addAudioBtn2")?.addEventListener("click", openAudioPicker);
  qs("audioFileInput").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    qs("audioEmpty").textContent = "Decoding audio…";
    qs("audioEmpty").classList.remove("hidden");
    try {
      const buffer = await decodeAudioFile(file);
      const start = clampRange(currentTime(), 0, Math.max(0, duration - audioTrackDesc.minDuration));
      const segDuration = clampRange(buffer.duration, audioTrackDesc.minDuration, Math.max(audioTrackDesc.minDuration, duration - start));
      const seg = {
        id: uid(),
        start,
        duration: segDuration,
        fileOffset: 0,
        bufferDuration: buffer.duration,
        buffer,
        file,
        name: file.name,
        volume: 1,
        muted: false,
        enabled: true
      };
      audioTracks.push(seg);
      audioTracks.sort((a, b) => a.start - b.start);
      selectedAudioId = seg.id;
      showPanel("audio");
      paintSeg(audioTrackDesc);
      render();
    } catch {
      qs("audioEmpty").textContent = "Could not decode that audio file. Try an MP3 or WAV.";
    }
  });
  qs("saveAudioBtn")?.addEventListener("click", saveAudioSegment);
  qs("deleteAudioBtn").addEventListener("click", () => {
    if (selectedAudioId) removeSegment("audio", selectedAudioId);
  });
  qs("audioEnabled").addEventListener("change", () => {
    const seg = audioTracks.find((s) => s.id === selectedAudioId);
    if (!seg) return;
    seg.enabled = qs("audioEnabled").checked;
    setDirty("audio", true);
    paintSeg(audioTrackDesc);
    render();
  });
  qs("audioMuted").addEventListener("change", () => {
    const seg = audioTracks.find((s) => s.id === selectedAudioId);
    if (!seg) return;
    seg.muted = qs("audioMuted").checked;
    setDirty("audio", true);
    paintSeg(audioTrackDesc);
    render();
  });
  qs("audioVolume").addEventListener("input", () => {
    qs("audioVolumeVal").textContent = `${Math.round(Number(qs("audioVolume").value) * 100)}%`;
    const seg = audioTracks.find((s) => s.id === selectedAudioId);
    if (!seg) return;
    seg.volume = Number(qs("audioVolume").value);
    setDirty("audio", true);
  });
  qs("audioStart").addEventListener("input", () => setDirty("audio", true));
  qs("audioDuration").addEventListener("input", () => setDirty("audio", true));

  qs("trimStart").addEventListener("input", () => setDirty("trim", true));
  qs("trimEnd").addEventListener("input", () => setDirty("trim", true));
  ["smoothMove", "followLag", "alwaysFollow"].forEach((id) => {
    const el = qs(id);
    if (!el) return;
    el.addEventListener("input", render);
    el.addEventListener("change", render);
  });
  qs("followLag")?.addEventListener("input", () => {
    const value = Number(qs("followLag").value);
    qs("followLagVal").textContent = value < 0.26 ? "Snappy" : value > 0.48 ? "Glide" : "Cinematic";
  });

  const cursorTiles = [];
  function refreshCursorPicker() {
    for (const tile of cursorTiles) {
      tile.el.classList.toggle("selected", tile.id === cursorStyle);
      const ctx2d = tile.ctx;
      ctx2d.clearRect(0, 0, 40, 40);
      if (tile.id === "none") {
        ctx2d.strokeStyle = "#9a9386";
        ctx2d.lineWidth = 1.6;
        ctx2d.beginPath();
        ctx2d.arc(20, 20, 10, 0, Math.PI * 2);
        ctx2d.moveTo(13, 13);
        ctx2d.lineTo(27, 27);
        ctx2d.stroke();
      } else {
        drawCursorGlyph(ctx2d, tile.id, 20, 20, false, cursorColor);
      }
    }
    qs("cursorProNote").classList.toggle("hidden", !isProLocked(cursorStyle, settings, CURSOR_STYLES));
    qs("cursorColorField").classList.toggle("hidden", cursorStyle === "none");
  }
  function buildCursorPicker() {
    const wrap = qs("cursorPicker");
    wrap.innerHTML = "";
    cursorTiles.length = 0;
    for (const [id, preset] of Object.entries(CURSOR_STYLES)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cursor-tile";
      btn.title = preset.label;
      const previewCanvas = document.createElement("canvas");
      previewCanvas.width = 40;
      previewCanvas.height = 40;
      const label = document.createElement("span");
      label.className = "cursor-tile-label";
      label.textContent = preset.label;
      btn.append(previewCanvas, label);
      if (preset.pro) {
        const badge = document.createElement("span");
        badge.className = "cursor-tile-pro";
        badge.textContent = "PRO";
        btn.appendChild(badge);
      }
      btn.addEventListener("click", () => {
        cursorStyle = id;
        chrome.storage.sync.set({ cursorStyle }).catch(() => {});
        refreshCursorPicker();
        render();
      });
      wrap.appendChild(btn);
      cursorTiles.push({ id, el: btn, ctx: previewCanvas.getContext("2d") });
    }
    refreshCursorPicker();
  }
  buildCursorPicker();

  const clickEffectTiles = [];
  function refreshClickEffectPicker() {
    for (const tile of clickEffectTiles) {
      tile.el.classList.toggle("selected", tile.id === clickEffectStyle);
      tile.ctx.clearRect(0, 0, 40, 40);
      if (tile.id === "none") {
        tile.ctx.strokeStyle = "#9a9386";
        tile.ctx.lineWidth = 1.6;
        tile.ctx.beginPath();
        tile.ctx.arc(20, 20, 10, 0, Math.PI * 2);
        tile.ctx.moveTo(13, 13);
        tile.ctx.lineTo(27, 27);
        tile.ctx.stroke();
      } else {
        // A mid-animation frame reads as the clearest preview of each effect.
        drawClickEffect(tile.ctx, tile.id, 20, 20, 0.35, cursorColor);
      }
    }
    qs("clickEffectProNote").classList.toggle("hidden", !isProLocked(clickEffectStyle, settings, CLICK_EFFECTS));
  }
  function buildClickEffectPicker() {
    const wrap = qs("clickEffectPicker");
    wrap.innerHTML = "";
    clickEffectTiles.length = 0;
    for (const [id, preset] of Object.entries(CLICK_EFFECTS)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cursor-tile";
      btn.title = preset.label;
      const previewCanvas = document.createElement("canvas");
      previewCanvas.width = 40;
      previewCanvas.height = 40;
      const label = document.createElement("span");
      label.className = "cursor-tile-label";
      label.textContent = preset.label;
      btn.append(previewCanvas, label);
      if (preset.pro) {
        const badge = document.createElement("span");
        badge.className = "cursor-tile-pro";
        badge.textContent = "PRO";
        btn.appendChild(badge);
      }
      btn.addEventListener("click", () => {
        clickEffectStyle = id;
        chrome.storage.sync.set({ clickEffect: id }).catch(() => {});
        refreshClickEffectPicker();
        render();
      });
      wrap.appendChild(btn);
      clickEffectTiles.push({ id, el: btn, ctx: previewCanvas.getContext("2d") });
    }
    refreshClickEffectPicker();
  }
  buildClickEffectPicker();

  qs("cursorColor").value = cursorColor;
  qs("cursorColor").addEventListener("input", () => {
    cursorColor = qs("cursorColor").value;
    chrome.storage.sync.set({ cursorColor }).catch(() => {});
    refreshCursorPicker();
    refreshClickEffectPicker();
    render();
  });

  qs("cropAspect").addEventListener("change", () => {
    const ratio = ASPECT_RATIOS[qs("cropAspect").value];
    crop = ratio ? cropForAspect(ratio, video.videoWidth, video.videoHeight) : { x: 0, y: 0, w: 1, h: 1 };
    render();
  });

  qs("fullscreenBtn").addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else stageFrame.requestFullscreen?.().catch(() => {});
  });
  document.addEventListener("fullscreenchange", () => {
    const active = document.fullscreenElement === stageFrame;
    qs("fullscreenBtn").classList.toggle("is-fullscreen", active);
    qs("fullscreenBtn").title = active ? "Exit fullscreen" : "Fullscreen";
  });

  qs("timelineZoomIn").addEventListener("click", () => {
    fitMode = false;
    pps = clampRange(pps * 1.35, 4, 400);
    layoutTimeline();
  });
  qs("timelineZoomOut").addEventListener("click", () => {
    fitMode = false;
    pps = clampRange(pps / 1.35, 4, 400);
    layoutTimeline();
  });
  qs("timelineFit").addEventListener("click", () => {
    fitMode = true;
    layoutTimeline();
  });

  document.addEventListener("keydown", (event) => {
    if (editView.classList.contains("hidden") || exporting) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (panel === "speed") saveSpeedSegment();
      else if (panel === "cut") saveCutSegment();
      else if (panel === "audio") saveAudioSegment();
      else if (panel === "trim") saveTrim();
      else if (panel === "zoom") saveZoomSegment();
      return;
    }
    const tag = event.target.tagName;
    if (tag === "INPUT" || tag === "SELECT") return;
    if (event.code === "Space") {
      event.preventDefault();
      playBtn.click();
    }
    // Only zoom/speed/cut/audio hold a deletable segment - trim and motion
    // don't, so Backspace there is a no-op instead of deleting whatever
    // segment happened to be selected elsewhere.
    if (event.key === "Delete" || event.key === "Backspace") {
      if (panel === "zoom") qs("deleteZoomBtn").click();
      else if (panel === "speed") qs("deleteSpeedBtn").click();
      else if (panel === "cut") qs("deleteCutBtn").click();
      else if (panel === "audio") qs("deleteAudioBtn").click();
    }
  });

  // Keeps the canvas live while editing. Skipped during export so the
  // offline renderer can seek frame-by-frame without fighting playback.
  let lastTick = 0;
  function tick(now) {
    if (!editView.classList.contains("hidden") && !exporting) {
      if (!lastTick || now - lastTick >= 16) {
        lastTick = now;
        render();
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  function setExportStatus(text, pct) {
    qs("exportStatus").textContent = text;
    const overlayStatus = qs("exportOverlayStatus");
    if (overlayStatus) overlayStatus.textContent = text;
    if (pct != null) {
      const bar = qs("exportProgressBar");
      if (bar) bar.style.width = `${Math.round(clampRange(pct, 0, 1) * 100)}%`;
    }
  }

  function updateExportCredits() {
    const note = qs("exportCreditsNote");
    if (!note) return;
    if (settings.pro) {
      note.classList.add("hidden");
      return;
    }
    const left = remainingFreeExports(settings);
    note.textContent = left > 0 ? `${left} free export${left === 1 ? "" : "s"} left` : "No free exports left";
    note.classList.remove("hidden");
  }
  updateExportCredits();

  function showPaywall() {
    qs("licenseStatus").textContent = "";
    qs("licenseStatus").className = "license-status";
    qs("paywallOverlay").classList.remove("hidden");
  }
  function hidePaywall() {
    qs("paywallOverlay").classList.add("hidden");
  }
  qs("paywallCloseBtn").addEventListener("click", hidePaywall);
  qs("activateLicenseBtn").addEventListener("click", async () => {
    const btn = qs("activateLicenseBtn");
    const status = qs("licenseStatus");
    btn.disabled = true;
    status.className = "license-status";
    status.textContent = "Activating…";
    try {
      const { key } = await activateLicense(qs("licenseKeyInput").value);
      settings.pro = true;
      settings.licenseKey = key;
      await chrome.storage.sync.set({ pro: true, licenseKey: key }).catch(() => {});
      status.className = "license-status success";
      status.textContent = "Activated — thanks for going Pro.";
      updateExportCredits();
      setTimeout(() => {
        hidePaywall();
        qs("exportBtn").click();
      }, 700);
    } catch (err) {
      status.className = "license-status error";
      status.textContent = err.message || "Could not activate that key.";
    } finally {
      btn.disabled = false;
    }
  });

  qs("exportBtn").addEventListener("click", async () => {
    if (exporting || !duration) return;
    if (!video.videoWidth || !video.videoHeight) {
      qs("exportStatus").textContent = "Video is still loading…";
      return;
    }
    if (zoomDirty) saveZoomSegment();
    if (speedDirty) saveSpeedSegment();
    if (cutDirty) saveCutSegment();
    if (audioDirty) saveAudioSegment();
    if (trimDirty) saveTrim();

    const qualityId = qs("exportQuality")?.value || settings.quality || "1080p";
    if (isProLocked(qualityId, settings)) {
      setExportStatus("That quality is Pro. Pick 1080p or below, or unlock Pro.");
      return;
    }
    if (isProLocked(cursorStyle, settings, CURSOR_STYLES)) {
      setExportStatus("That cursor style is Pro. Pick Arrow, Dot, or Hidden, or unlock Pro.");
      return;
    }
    if (isProLocked(clickEffectStyle, settings, CLICK_EFFECTS)) {
      setExportStatus("That click effect is Pro. Pick None or Ripple, or unlock Pro.");
      return;
    }
    if (!canExport(settings)) {
      showPaywall();
      return;
    }

    exporting = true;
    qs("exportBtn").disabled = true;
    playBtn.disabled = true;
    video.pause();
    pauseAudioPreviews();
    qs("exportOverlay").classList.remove("hidden");
    qs("exportProgressBar").style.width = "0%";

    const size = resolveExportSize(
      video.videoWidth,
      video.videoHeight,
      capture.frameRate || 60,
      qualityId,
      crop
    );
    setExportStatus(`Exporting ${size.width}×${size.height} @ ${size.fps}fps…`, 0);

    const encodeCanvas = document.createElement("canvas");
    encodeCanvas.width = size.width;
    encodeCanvas.height = size.height;
    const encodeCtx = encodeCanvas.getContext("2d", { alpha: false, colorSpace: "srgb" });

    const wasMuted = video.muted;
    video.muted = true;

    try {
      const result = await renderOfflineExport({
        video,
        canvas: encodeCanvas,
        ctx: encodeCtx,
        clips,
        samples,
        speeds,
        cuts,
        trimStart,
        trimEnd,
        fps: size.fps,
        width: size.width,
        height: size.height,
        motion: cameraOptions(false),
        audioBlob,
        audioTracks,
        crop,
        cursorStyle,
        cursorColor,
        clicks,
        clickEffectStyle,
        onProgress(pct, outputTime) {
          setExportStatus(`Exporting ${Math.round(pct * 100)}% · ${formatClock(outputTime)}`, pct);
        }
      });
      setExportStatus("Choose where to save the MP4…", 1);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filename = `zinra-${stamp}.mp4`;
      const url = URL.createObjectURL(result.blob);
      try {
        await chrome.downloads.download({ url, filename, saveAs: true });
      } catch {
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        link.click();
      }
      setExportStatus(
        `Saved ${result.width}×${result.height} ${result.fps}fps MP4` +
        (result.hasAudio ? "." : " (silent)."),
        1
      );
      if (!settings.pro) {
        settings.exportCount = (Number(settings.exportCount) || 0) + 1;
        chrome.storage.sync.set({ exportCount: settings.exportCount }).catch(() => {});
        updateExportCredits();
      }
    } catch (err) {
      setExportStatus(err.message || "Export failed.");
    } finally {
      video.muted = wasMuted;
      video.pause();
      video.playbackRate = 1;
      exporting = false;
      qs("exportBtn").disabled = false;
      playBtn.disabled = false;
      qs("exportOverlay").classList.add("hidden");
      render();
    }
  });


  (async () => {
    try {
      duration = await resolveDuration(video, recordedSeconds);
      trimStart = 0;
      trimEnd = duration;
      video.currentTime = 0;
      video.muted = false;
      if (video.videoWidth && video.videoHeight) {
        video.width = video.videoWidth;
        video.height = video.videoHeight;
      }
      for (const clip of clips) {
        clip.start = clampRange(clip.start, 0, Math.max(0, duration - 0.2));
        clip.duration = Math.min(clip.duration, Math.max(0.2, duration - clip.start));
      }
      fitMode = true;
      if (qs("exportQuality") && settings.quality) qs("exportQuality").value = settings.quality;
      qs("exportQuality")?.addEventListener("change", () => {
        chrome.storage.sync.set({ quality: qs("exportQuality").value }).catch(() => {});
      });
      layoutTimeline();
      if (typeof ResizeObserver !== "undefined") {
        new ResizeObserver(() => {
          if (fitMode) layoutTimeline();
        }).observe(timelineScroll);
      }
      if (loadStatus) loadStatus.classList.add("hidden");
    } catch (err) {
      if (loadStatus) loadStatus.textContent = err.message || "Could not load the recording.";
    }
  })();
}
