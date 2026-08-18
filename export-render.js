import { Muxer, ArrayBufferTarget } from "./mp4-muxer.mjs";
import { cameraAt, drawFrame, resetCameraCache, samplePointer } from "./compositor.js";
import { exportVideoBitrate } from "./encode.js";

function even(n) {
  const v = Math.max(2, Math.round(Number(n) || 0));
  return v % 2 === 0 ? v : v - 1;
}

function avcMainCodec(width, height, fps) {
  if (height > 1440 || width > 2560) return "avc1.4D4033";
  if (height > 1080 || width > 1920) return "avc1.4D4032";
  if (fps > 30) return "avc1.4D402A";
  if (height > 720) return "avc1.4D4028";
  return "avc1.4D401F";
}

function rgbaToI420(rgba, width, height, out) {
  const ySize = width * height;
  const cW = width >> 1;
  const uOff = ySize;
  const vOff = ySize + cW * (height >> 1);
  let src = 0;
  let y = 0;
  for (let row = 0; row < height; row++) {
    const chromaRow = (row & 1) === 0;
    for (let col = 0; col < width; col++) {
      const r = rgba[src];
      const g = rgba[src + 1];
      const b = rgba[src + 2];
      src += 4;
      const yv = ((47 * r + 157 * g + 16 * b) >> 8) + 16;
      out[y++] = yv < 16 ? 16 : yv > 235 ? 235 : yv;
      if (chromaRow && (col & 1) === 0) {
        const ci = (row >> 1) * cW + (col >> 1);
        const u = ((-26 * r - 87 * g + 112 * b) >> 8) + 128;
        const v = ((112 * r - 102 * g - 10 * b) >> 8) + 128;
        out[uOff + ci] = u < 16 ? 16 : u > 240 ? 240 : u;
        out[vOff + ci] = v < 16 ? 16 : v > 240 ? 240 : v;
      }
    }
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function skipCutsAt(t, cuts) {
  for (let i = 0; i < 32; i++) {
    const cut = cuts.find((c) => c.enabled !== false && t >= c.start && t < c.start + c.duration);
    if (!cut) return t;
    t = cut.start + cut.duration;
  }
  return t;
}

function speedAt(t, speeds) {
  const seg = speeds.find((s) => s.enabled !== false && t >= s.start && t < s.start + s.duration);
  return seg ? Math.max(0.05, Number(seg.multiplier) || 1) : 1;
}

export function buildExportFrames({ trimStart, trimEnd, fps, speeds, cuts }) {
  const rate = Math.max(1, Number(fps) || 30);
  const start = Number.isFinite(trimStart) ? Math.max(0, trimStart) : 0;
  const end = Number.isFinite(trimEnd) ? trimEnd : start;
  const span = clamp(end - start, 0.05, 60 * 90);
  const dt = 1 / rate;
  const frames = [];
  let source = start;
  let output = 0;
  const guard = Math.ceil(span * rate * 10) + 8;
  for (let i = 0; i < guard; i++) {
    source = skipCutsAt(source, cuts);
    if (source >= end - 1e-4) break;
    frames.push({ sourceTime: source, outputTime: output });
    source += dt * speedAt(source, speeds);
    output += dt;
  }
  return frames;
}

function seekTo(video, time) {
  const duration = Number.isFinite(video.duration) ? video.duration : time + 1;
  const target = clamp(time, 0, Math.max(0, duration - 0.0005));
  if (Math.abs(video.currentTime - target) < 0.02 && video.readyState >= 2 && !video.seeking) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.removeEventListener("seeked", finish);
      video.removeEventListener("error", finish);
      resolve();
    };
    video.addEventListener("seeked", finish);
    video.addEventListener("error", finish);
    video.currentTime = target;
    setTimeout(finish, 70);
  });
}

async function configureEncoder(encoder, width, height, fps, bitrate) {
  const main = avcMainCodec(width, height, fps);
  const social = height <= 1080;
  const configs = [
    {
      codec: main,
      width,
      height,
      bitrate,
      framerate: fps,
      avc: { format: "avc" },
      hardwareAcceleration: social ? "prefer-software" : "prefer-hardware",
      latencyMode: "realtime",
      bitrateMode: "constant"
    },
    {
      codec: main,
      width,
      height,
      bitrate,
      framerate: fps,
      avc: { format: "avc" },
      hardwareAcceleration: "prefer-hardware",
      latencyMode: "realtime",
      bitrateMode: "constant"
    },
    {
      codec: "avc1.4D4028",
      width,
      height,
      bitrate: Math.min(bitrate, 8_000_000),
      framerate: Math.min(30, fps),
      avc: { format: "avc" },
      hardwareAcceleration: "prefer-software",
      latencyMode: "realtime"
    },
    {
      codec: "avc1.42E01E",
      width,
      height,
      bitrate: Math.min(bitrate, 5_000_000),
      framerate: Math.min(30, fps),
      avc: { format: "avc" },
      hardwareAcceleration: "prefer-software"
    }
  ];
  for (const config of configs) {
    try {
      const support = await Promise.race([
        VideoEncoder.isConfigSupported(config),
        sleep(400).then(() => null)
      ]);
      if (support && support.supported === false) continue;
      encoder.configure(config);
      return config;
    } catch {
      // Try a simpler profile.
    }
  }
  throw new Error("No H.264 encoder available for this resolution.");
}

async function drainEncoder(encoder, maxQueue = 18) {
  const start = performance.now();
  while (encoder.encodeQueueSize > maxQueue) {
    if (performance.now() - start > 2500) return;
    await new Promise((resolve) => {
      encoder.ondequeue = () => resolve();
      setTimeout(resolve, 6);
    });
  }
}

function outputToSource(outT, frames, fps) {
  if (!frames.length) return 0;
  const idx = clamp(outT * fps, 0, frames.length - 1);
  const i = Math.floor(idx);
  const u = idx - i;
  const a = frames[i].sourceTime;
  const b = frames[Math.min(frames.length - 1, i + 1)].sourceTime;
  if (b - a > 0.12) return a;
  return a + (b - a) * u;
}

async function decodeAudioBuffer(blob) {
  if (!blob?.size) return null;
  let ctx;
  try {
    ctx = new AudioContext();
    const decoded = blob.arrayBuffer().then((ab) => ctx.decodeAudioData(ab));
    return await Promise.race([decoded, sleep(20000).then(() => null)]);
  } catch {
    return null;
  } finally {
    try { ctx?.close(); } catch { /* ignore */ }
  }
}

function timeWarpNeeded(speeds, cuts) {
  return speeds.some((s) => s.enabled !== false && Math.abs((Number(s.multiplier) || 1) - 1) > 0.01)
    || cuts.some((c) => c.enabled !== false && c.duration > 0.02);
}

async function encodeAudio(muxer, buffer, audioTracks, frames, fps, speeds, cuts, trimStart) {
  if (typeof AudioEncoder === "undefined") return false;
  const sampleRate = 44100;
  const channels = 2;
  const duration = frames.length / fps;
  const total = Math.max(1, Math.ceil(duration * sampleRate));
  const planar = Array.from({ length: channels }, () => new Float32Array(total));

  if (buffer) {
    const srcRate = buffer.sampleRate;
    const mapped = timeWarpNeeded(speeds, cuts);
    const srcChannels = buffer.numberOfChannels || 1;
    if (!mapped) {
      const startIndex = trimStart * srcRate;
      for (let i = 0; i < total; i++) {
        const srcIndex = startIndex + (i / sampleRate) * srcRate;
        const i0 = srcIndex | 0;
        const frac = srcIndex - i0;
        for (let c = 0; c < channels; c++) {
          const data = buffer.getChannelData(Math.min(c, srcChannels - 1));
          planar[c][i] = (data[i0] || 0) + ((data[i0 + 1] || 0) - (data[i0] || 0)) * frac;
        }
      }
    } else {
      for (let i = 0; i < total; i++) {
        const srcIndex = outputToSource(i / sampleRate, frames, fps) * srcRate;
        const i0 = srcIndex | 0;
        const frac = srcIndex - i0;
        for (let c = 0; c < channels; c++) {
          const data = buffer.getChannelData(Math.min(c, srcChannels - 1));
          const last = data.length - 1;
          const a = data[clamp(i0, 0, last)] || 0;
          const b = data[clamp(i0 + 1, 0, last)] || 0;
          planar[c][i] = a + (b - a) * frac;
        }
      }
    }
  }

  // Imported voiceover/music tracks are placed in the same source-time
  // coordinates as zoom/speed/cut, so the same outputToSource mapping used
  // for the captured mic/tab audio above keeps them glued to the footage.
  for (const track of audioTracks || []) {
    if (track.enabled === false || track.muted || !track.buffer) continue;
    const gain = clamp(Number(track.volume) || 1, 0, 4);
    const srcRate = track.buffer.sampleRate;
    const srcChannels = track.buffer.numberOfChannels || 1;
    const fileOffset = Number(track.fileOffset) || 0;
    const trackStart = Number(track.start) || 0;
    const trackEnd = trackStart + (Number(track.duration) || 0);
    for (let i = 0; i < total; i++) {
      const srcT = outputToSource(i / sampleRate, frames, fps);
      if (srcT < trackStart || srcT >= trackEnd) continue;
      const fileT = fileOffset + (srcT - trackStart);
      const srcIndex = fileT * srcRate;
      const i0 = srcIndex | 0;
      const frac = srcIndex - i0;
      for (let c = 0; c < channels; c++) {
        const data = track.buffer.getChannelData(Math.min(c, srcChannels - 1));
        const last = data.length - 1;
        const a = data[clamp(i0, 0, last)] || 0;
        const b = data[clamp(i0 + 1, 0, last)] || 0;
        planar[c][i] += (a + (b - a) * frac) * gain;
      }
    }
  }
  if (audioTracks && audioTracks.length) {
    for (let c = 0; c < channels; c++) {
      const ch = planar[c];
      for (let i = 0; i < total; i++) ch[i] = clamp(ch[i], -1, 1);
    }
  }

  const encoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (err) => console.warn("Audio encode error", err)
  });
  const config = {
    codec: "mp4a.40.2",
    numberOfChannels: channels,
    sampleRate,
    bitrate: 128_000
  };
  try {
    const support = await Promise.race([
      AudioEncoder.isConfigSupported(config),
      sleep(400).then(() => null)
    ]);
    if (support && support.supported === false) {
      encoder.close();
      return false;
    }
    encoder.configure(config);
  } catch {
    try { encoder.close(); } catch { /* ignore */ }
    return false;
  }

  const frameSize = 1024;
  const packed = new Float32Array(frameSize * channels);
  for (let offset = 0; offset < total; offset += frameSize) {
    const count = Math.min(frameSize, total - offset);
    for (let c = 0; c < channels; c++) {
      packed.set(planar[c].subarray(offset, offset + count), c * count);
    }
    const data = new AudioData({
      format: "f32-planar",
      sampleRate,
      numberOfChannels: channels,
      numberOfFrames: count,
      timestamp: Math.round((offset / sampleRate) * 1e6),
      data: packed.slice(0, count * channels)
    });
    encoder.encode(data);
    data.close();
  }
  await Promise.race([encoder.flush(), sleep(8000)]);
  try { encoder.close(); } catch { /* ignore */ }
  return true;
}

export async function renderOfflineExport({
  video,
  canvas,
  ctx,
  clips,
  samples,
  speeds,
  cuts,
  trimStart,
  trimEnd,
  fps,
  width: outW,
  height: outH,
  motion,
  audioBlob,
  audioTracks,
  crop,
  cursorStyle,
  onProgress
}) {
  const width = even(outW || video.videoWidth);
  const height = even(outH || video.videoHeight);
  if (!width || !height) throw new Error("Video is still loading.");
  if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") {
    throw new Error("This Chrome build can’t encode offline. Use a current Chrome.");
  }

  const frames = buildExportFrames({ trimStart, trimEnd, fps, speeds, cuts });
  if (!frames.length) throw new Error("Nothing to export in this trim range.");

  onProgress?.(0, 0);
  const audioPromise = decodeAudioBuffer(audioBlob);
  const bitrate = exportVideoBitrate(width, height, fps);
  const canAudio = typeof AudioEncoder !== "undefined";
  const i420 = new Uint8Array(width * height + 2 * (width >> 1) * (height >> 1));
  const ySize = width * height;
  const uvSize = (width >> 1) * (height >> 1);
  const i420Layout = [
    { offset: 0, stride: width },
    { offset: ySize, stride: width >> 1 },
    { offset: ySize + uvSize, stride: width >> 1 }
  ];
  let useI420 = true;

  let chunksOut = 0;
  let muxer = null;
  let encodeError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      muxer?.addVideoChunk(chunk, meta);
      chunksOut += 1;
    },
    error: (err) => { encodeError = err; }
  });

  try {
    await configureEncoder(encoder, width, height, fps, bitrate);
  } catch (err) {
    try { encoder.close(); } catch { /* ignore */ }
    throw err;
  }

  muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width, height },
    audio: canAudio ? {
      codec: "aac",
      numberOfChannels: 2,
      sampleRate: 44100
    } : undefined,
    fastStart: "in-memory",
    firstTimestampBehavior: "offset"
  });

  video.pause();
  video.playbackRate = 1;
  resetCameraCache();

  let lastSource = -1;
  const keyEvery = Math.max(1, Math.round(fps * 2));
  const drawOpts = { width, height, fast: true, crop };
  const seekSlack = 0.45 / Math.max(24, fps);
  const showCursor = cursorStyle && cursorStyle !== "none";

  try {
    for (let i = 0; i < frames.length; i++) {
      if (encodeError) throw encodeError;
      const { sourceTime, outputTime } = frames[i];
      if (Math.abs(video.currentTime - sourceTime) > seekSlack || video.readyState < 2) {
        await seekTo(video, sourceTime);
      }
      if (sourceTime - lastSource > 1) resetCameraCache();
      lastSource = sourceTime;
      const camera = cameraAt(sourceTime, clips, samples, motion);
      drawOpts.cursor = showCursor
        ? { style: cursorStyle, ...samplePointer(samples, sourceTime) }
        : null;
      drawFrame(ctx, video, camera, drawOpts);
      const timestamp = Math.round(outputTime * 1e6);
      const durationUs = Math.round(1e6 / fps);
      let frame;
      if (useI420) {
        try {
          rgbaToI420(ctx.getImageData(0, 0, width, height).data, width, height, i420);
          frame = new VideoFrame(i420, {
            format: "I420",
            codedWidth: width,
            codedHeight: height,
            timestamp,
            duration: durationUs,
            layout: i420Layout
          });
        } catch {
          useI420 = false;
          frame = new VideoFrame(canvas, { timestamp, duration: durationUs, alpha: "discard" });
        }
      } else {
        frame = new VideoFrame(canvas, { timestamp, duration: durationUs, alpha: "discard" });
      }
      encoder.encode(frame, { keyFrame: i % keyEvery === 0 });
      frame.close();
      if (encoder.encodeQueueSize > 18) await drainEncoder(encoder, 8);
      if (i % 10 === 0) {
        onProgress?.(i / frames.length, outputTime);
        await sleep(0);
      }
    }
    await drainEncoder(encoder, 0);
    await Promise.race([encoder.flush(), sleep(10000)]);
  } finally {
    video.pause();
    video.playbackRate = 1;
    try { encoder.close(); } catch { /* ignore */ }
  }

  if (encodeError) throw encodeError;
  if (!chunksOut) throw new Error("Encoder produced no frames. Try 720p, then export again.");

  let hasAudio = false;
  if (canAudio) {
    const decodedAudio = await audioPromise;
    try {
      hasAudio = await encodeAudio(muxer, decodedAudio, audioTracks, frames, fps, speeds, cuts, trimStart);
    } catch {
      hasAudio = false;
    }
    if (!hasAudio) {
      throw new Error("Could not write AAC audio. Re-export in current Chrome.");
    }
  }

  try {
    muxer.finalize();
  } catch (err) {
    throw new Error(err.message || "Could not finish the MP4.");
  }
  return {
    blob: new Blob([muxer.target.buffer], { type: "video/mp4" }),
    width,
    height,
    fps,
    hasAudio,
    frames: frames.length
  };
}
