import { QUALITY_PRESETS } from "./settings.js";

// Shared MediaRecorder settings for capture and export.
// Screen recordings (sharp UI/text) need a higher profile, more bits, and a
// "detail" hint - camera-video defaults smear code and chrome.

export function supportsHwMp4() {
  return MediaRecorder.isTypeSupported("video/mp4;codecs=avc1.640033,mp4a.40.2")
    || MediaRecorder.isTypeSupported("video/mp4;codecs=avc1.640032,mp4a.40.2")
    || MediaRecorder.isTypeSupported("video/mp4;codecs=avc1.640028,mp4a.40.2")
    || MediaRecorder.isTypeSupported("video/mp4");
}

export function pickMime(hasAudio) {
  const types = hasAudio
    ? [
      // High@L5.1 is the first level that actually allows 4K60.
      "video/mp4;codecs=avc1.640033,mp4a.40.2",
      "video/mp4;codecs=avc1.640032,mp4a.40.2",
      "video/mp4;codecs=avc1.640028,mp4a.40.2",
      "video/mp4;codecs=h264,aac",
      "video/mp4",
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm"
    ]
    : [
      "video/mp4;codecs=avc1.640033",
      "video/mp4;codecs=avc1.640032",
      "video/mp4;codecs=avc1.640028",
      "video/mp4",
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm"
    ];
  return types.find((type) => MediaRecorder.isTypeSupported(type)) || "video/webm";
}

export function isMp4Mime(mime) {
  return typeof mime === "string" && mime.includes("mp4");
}

export function trackSize(stream) {
  const settings = stream?.getVideoTracks?.()[0]?.getSettings?.() || {};
  return {
    width: settings.width || 0,
    height: settings.height || 0,
    frameRate: settings.frameRate || 0
  };
}

export function videoBitrate(width, height, fps, hwEncode) {
  const w = width || 1920;
  const h = height || 1080;
  const rate = Math.max(24, fps || 30);
  // ~0.20 bits/pixel/frame is high-quality screen content on hardware H.264.
  // Software WebM falls over if we push that hard, so it stays conservative.
  const bitsPerPixel = hwEncode ? 0.2 : 0.1;
  const estimated = Math.round(w * h * rate * bitsPerPixel);
  const min = hwEncode ? 20_000_000 : 8_000_000;
  const max = hwEncode ? 80_000_000 : 16_000_000;
  return Math.min(max, Math.max(min, estimated));
}

export function audioBitrate(hwEncode) {
  return hwEncode ? 256_000 : 192_000;
}

export function exportVideoBitrate(width, height, fps) {
  const w = width || 1920;
  const h = height || 1080;
  const rate = Math.max(24, fps || 30);
  // Instagram / TikTok transcode rejects very high bitrates and 4:4:4 High profile.
  const estimated = Math.round(w * h * rate * 0.06);
  return Math.min(8_000_000, Math.max(3_000_000, estimated));
}

export function exportFps(captureFps) {
  const n = Number(captureFps);
  if (n >= 48) return 60;
  if (n >= 20) return Math.round(n);
  return 60;
}

function even(n) {
  const v = Math.max(2, Math.round(n));
  return v % 2 === 0 ? v : v - 1;
}

export function resolveExportSize(srcW, srcH, captureFps, qualityId, crop) {
  const preset = QUALITY_PRESETS[qualityId] || QUALITY_PRESETS["1080p"];
  const baseW = crop ? Math.round((srcW || 1920) * (Number(crop.w) || 1)) : srcW;
  const baseH = crop ? Math.round((srcH || 1080) * (Number(crop.h) || 1)) : srcH;
  let width = even(baseW || 1920);
  let height = even(baseH || 1080);
  if (Number.isFinite(preset.maxHeight) && height > preset.maxHeight) {
    const scale = preset.maxHeight / height;
    width = even(width * scale);
    height = even(height * scale);
  }
  const captured = exportFps(captureFps);
  let fps = preset.fps ? Math.min(preset.fps, captured) : captured;
  if (qualityId === "auto" || !preset.fps) fps = Math.min(30, fps);
  if (fps > 30 && qualityId !== "1080p60") fps = 30;
  return { width, height, fps, preset };
}

export function applyDetailHint(stream) {
  if (!stream) return;
  for (const track of stream.getVideoTracks()) {
    try {
      track.contentHint = "detail";
    } catch {
      // Older Chrome ignores contentHint.
    }
  }
}

export async function preferHighFps(track) {
  if (!track?.applyConstraints) return;
  try {
    await track.applyConstraints({ frameRate: { ideal: 60 } });
  } catch {
    try {
      await track.applyConstraints({ frameRate: { ideal: 60 } });
    } catch {
      // Tab capture often rejects optional constraints.
    }
  }
}

function recorderConfig(mime, width, height, fps) {
  const hwEncode = isMp4Mime(mime);
  return {
    mimeType: mime,
    videoBitsPerSecond: videoBitrate(width, height, fps, hwEncode),
    audioBitsPerSecond: audioBitrate(hwEncode),
    bitrateMode: "constant",
    videoKeyFrameIntervalDuration: 2
  };
}

export function createRecorder(stream, mime, width, height, fps) {
  const full = recorderConfig(mime, width, height, fps);
  try {
    return new MediaRecorder(stream, full);
  } catch {
    try {
      return new MediaRecorder(stream, {
        mimeType: mime,
        videoBitsPerSecond: full.videoBitsPerSecond,
        audioBitsPerSecond: full.audioBitsPerSecond
      });
    } catch {
      return new MediaRecorder(stream, { mimeType: mime });
    }
  }
}
