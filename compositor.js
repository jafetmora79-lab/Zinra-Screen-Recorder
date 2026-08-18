function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function lastIndexAt(samples, t) {
  if (!samples.length || t < samples[0].t) return -1;
  let lo = 0;
  let hi = samples.length - 1;
  if (t >= samples[hi].t) return hi;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}

export function samplePointer(samples, t) {
  if (!samples.length) return { x: 0.5, y: 0.5, down: false };
  const i = lastIndexAt(samples, t);
  if (i < 0) return samples[0];
  if (i >= samples.length - 1) return samples[samples.length - 1];
  const a = samples[i];
  const b = samples[i + 1];
  const u = clamp((t - a.t) / Math.max(1e-6, b.t - a.t), 0, 1);
  return {
    x: a.x + (b.x - a.x) * u,
    y: a.y + (b.y - a.y) * u,
    down: u < 0.5 ? a.down : b.down
  };
}

export function smoothPointer(samples, t, tau = 0.12) {
  if (!samples.length) return { x: 0.5, y: 0.5, down: false };
  if (tau <= 0.012) return samplePointer(samples, t);
  const end = lastIndexAt(samples, t);
  if (end < 0) return samples[0];
  const cutoff = t - tau * 4.5;
  let wsum = 0;
  let x = 0;
  let y = 0;
  const down = samples[end].down;
  for (let i = end; i >= 0; i--) {
    const sample = samples[i];
    if (sample.t < cutoff) break;
    const weight = Math.exp(-(t - sample.t) / tau);
    x += sample.x * weight;
    y += sample.y * weight;
    wsum += weight;
  }
  if (wsum < 1e-6) return samplePointer(samples, t);
  return { x: x / wsum, y: y / wsum, down };
}

function followsCursor(clip) {
  return Boolean(clip) && clip.followCursor !== false;
}

// The clip that "owns" the camera at time t. A selected clip wins while the
// playhead is inside it, so switching Motion to "fixed" on one zoom cannot
// steal follow from another. Overlaps prefer a follow clip over a fixed one.
function activeClip(t, clips, preferredId) {
  const hits = [];
  for (const clip of clips) {
    if (clip.enabled === false) continue;
    if (t >= clip.start && t < clip.start + clip.duration) hits.push(clip);
  }
  if (!hits.length) return null;
  if (preferredId) {
    const picked = hits.find((clip) => clip.id === preferredId);
    if (picked) return picked;
  }
  const following = hits.filter(followsCursor);
  const pool = following.length ? following : hits;
  let best = pool[0];
  for (const clip of pool) {
    if (clip.start >= best.start) best = clip;
  }
  return best;
}

// Where the camera *wants* to be right now: dead center at rest zoom when no
// clip is active, otherwise the clip's fixed focus point or a live/anchored
// read of the cursor. This is a pure function of the current clips array, so
// dragging, resizing, or retargeting a clip on the timeline takes effect on
// the very next frame - no separate path to rebuild.
function cameraTarget(t, clips, samples, alwaysFollow, cursorTau, preferredId) {
  const clip = activeClip(t, clips, preferredId);
  if (!clip) return { x: 0.5, y: 0.5, zoom: 1 };
  const zoom = Number(clip.zoom) || 1;
  if (!followsCursor(clip)) {
    return { x: clip.x ?? 0.5, y: clip.y ?? 0.5, zoom };
  }
  const at = alwaysFollow ? t : clip.start;
  const pointer = smoothPointer(samples, at, cursorTau);
  return { x: pointer.x, y: pointer.y, zoom };
}

// Critically-damped spring chasing cameraTarget() - a segment change
// redirects the spring instead of snapping, which is what makes back-to-back
// zooms feel like a single continuous move instead of two separate jumps.
//
// Sequential playback/export calls this every frame with t advancing by one
// frame's worth each time, so rather than resimulating from a multi-second
// lookback from scratch every call (the original approach - correct, but up
// to ~60 integration steps per frame), we cache the last state and step
// forward just the gap since last time. Falls back to a full resim (still a
// pure function of t) whenever the cache doesn't cleanly apply - seeking,
// scrubbing backward, or a big jump - so correctness never depends on the
// cache; it only ever affects how much work a given call does.
let cache = null;

export function resetCameraCache() {
  cache = null;
}

function stepSpring(state, target, omega, zoomOmega, dt) {
  const ax = omega * omega * (target.x - state.x) - 2 * omega * state.vx;
  const ay = omega * omega * (target.y - state.y) - 2 * omega * state.vy;
  const az = zoomOmega * zoomOmega * (target.zoom - state.zoom) - 2 * zoomOmega * state.vz;
  state.vx += ax * dt;
  state.vy += ay * dt;
  state.vz += az * dt;
  state.x += state.vx * dt;
  state.y += state.vy * dt;
  state.zoom += state.vz * dt;
}

function springCamera(t, clips, samples, opts) {
  const settle = Math.max(0.14, opts.settle ?? 0.4);
  const omega = 1.7 / settle;
  const zoomOmega = omega * 1.15;
  const dt = 1 / 60;
  const preferredId = opts.preferredId || null;
  const live = activeClip(t, clips, preferredId);
  const followKey = live ? `${live.id}:${followsCursor(live)}` : "rest";

  // Keep the live spring when switching follow/fixed so a neighboring
  // "fixed" clip cannot park the camera for the rest of the session.
  const canContinue = cache
    && cache.alwaysFollow === opts.alwaysFollow
    && cache.cursorTau === opts.cursorTau
    && cache.settle === settle
    && t >= cache.t
    && t - cache.t <= 1.0;

  let state;
  if (canContinue) {
    state = cache;
  } else {
    const lookback = Math.min(3, Math.max(1.1, settle * 5));
    const start = Math.max(0, t - lookback);
    const first = cameraTarget(start, clips, samples, opts.alwaysFollow, opts.cursorTau, preferredId);
    state = {
      t: start,
      x: first.x,
      y: first.y,
      zoom: first.zoom,
      vx: 0,
      vy: 0,
      vz: 0,
      alwaysFollow: opts.alwaysFollow,
      cursorTau: opts.cursorTau,
      settle,
      followKey
    };
  }

  for (let time = state.t; time < t; time += dt) {
    const next = Math.min(t, time + dt);
    const target = cameraTarget(next, clips, samples, opts.alwaysFollow, opts.cursorTau, preferredId);
    stepSpring(state, target, omega, zoomOmega, dt);
  }
  state.t = t;
  state.followKey = followKey;
  cache = state;

  return { x: clamp(state.x, 0, 1), y: clamp(state.y, 0, 1), zoom: Math.max(1, state.zoom) };
}

export function cameraAt(t, clips, samples, motion = {}) {
  const alwaysFollow = motion.alwaysFollow !== false;
  const cursorTau = motion.smooth === false ? 0.008 : Number(motion.cursorTau ?? 0.08);
  const settle = motion.smooth === false ? 0.05 : Number(motion.cameraTau ?? 0.28);
  const preferredId = motion.selectedId || null;

  const cam = motion.smooth === false
    ? cameraTarget(t, clips, samples, alwaysFollow, cursorTau, preferredId)
    : springCamera(t, clips, samples, { alwaysFollow, cursorTau, settle, preferredId });

  return {
    zoom: cam.zoom,
    x: clamp(cam.x, 0, 1),
    y: clamp(cam.y, 0, 1),
    active: cam.zoom > 1.03
  };
}

function focusPoint(camera, w, h) {
  const zoom = Math.max(1, camera.zoom || 1);
  const pan = zoom <= 1.001 ? 0 : Math.min(0.92, (zoom - 1) / Math.max(0.25, zoom - 0.85));
  return {
    x: (0.5 + (camera.x - 0.5) * pan) * w,
    y: (0.5 + (camera.y - 0.5) * pan) * h,
    pan
  };
}

function normalizeCrop(crop) {
  if (!crop) return { x: 0, y: 0, w: 1, h: 1 };
  return {
    x: clamp(Number(crop.x) || 0, 0, 1),
    y: clamp(Number(crop.y) || 0, 0, 1),
    w: clamp(Number(crop.w) || 1, 0.05, 1),
    h: clamp(Number(crop.h) || 1, 0.05, 1)
  };
}

// samples/clicks are recorded against the *full* source frame, so anything
// placed with those coordinates (camera target, focus guide, cursor) needs
// remapping into the cropped region's local [0,1] space before it's drawn.
function toCropLocal(x, y, crop) {
  return {
    x: clamp((x - crop.x) / crop.w, 0, 1),
    y: clamp((y - crop.y) / crop.h, 0, 1)
  };
}

function drawCursorGlyph(ctx, style, x, y, down) {
  ctx.save();
  ctx.translate(x, y);
  ctx.lineJoin = "round";
  if (style === "arrow") {
    ctx.scale(down ? 0.92 : 1, down ? 0.92 : 1);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, 15);
    ctx.lineTo(3.6, 11.8);
    ctx.lineTo(6.2, 17.6);
    ctx.lineTo(8.6, 16.5);
    ctx.lineTo(6.1, 10.8);
    ctx.lineTo(10.4, 10.4);
    ctx.closePath();
    ctx.fillStyle = "#f3efe6";
    ctx.strokeStyle = "#1a1916";
    ctx.lineWidth = 1.6;
    ctx.fill();
    ctx.stroke();
  } else if (style === "dot") {
    const r = down ? 9 : 7;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(224, 180, 74, 0.92)";
    ctx.shadowColor = "rgba(224, 180, 74, 0.75)";
    ctx.shadowBlur = down ? 16 : 10;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = "#1a1916";
    ctx.stroke();
  } else if (style === "hand") {
    ctx.scale(down ? 0.92 : 1, down ? 0.92 : 1);
    ctx.fillStyle = "#f3efe6";
    ctx.strokeStyle = "#1a1916";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.roundRect(-5, 2, 11, 12, 4);
    ctx.fill();
    ctx.stroke();
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.roundRect(-4.5 + i * 3.6, -9, 3, 12, 1.5);
      ctx.fill();
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.roundRect(-9, 4, 4.5, 8, 2);
    ctx.fill();
    ctx.stroke();
  } else if (style === "ring") {
    const r = down ? 13 : 10;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.strokeStyle = "#e0b44a";
    ctx.lineWidth = down ? 3.2 : 2.2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, 2.4, 0, Math.PI * 2);
    ctx.fillStyle = "#e0b44a";
    ctx.fill();
  }
  ctx.restore();
}

export function drawFrame(ctx, video, camera, options = {}) {
  const srcW = video.videoWidth || 1280;
  const srcH = video.videoHeight || 720;
  const crop = normalizeCrop(options.crop);
  const cropX = crop.x * srcW;
  const cropY = crop.y * srcH;
  const cropW = Math.max(1, crop.w * srcW);
  const cropH = Math.max(1, crop.h * srcH);
  const w = options.width || cropW;
  const h = options.height || cropH;
  if (ctx.canvas.width !== w) ctx.canvas.width = w;
  if (ctx.canvas.height !== h) ctx.canvas.height = h;

  const localCam = toCropLocal(camera.x, camera.y, crop);
  const focus = focusPoint({ ...camera, x: localCam.x, y: localCam.y }, w, h);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#1a1916";
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.scale(camera.zoom, camera.zoom);
  ctx.translate(-focus.x, -focus.y);
  // 1:1 copy stays pixel-sharp; zoom or downscale uses high-quality resampling.
  const resample = (camera.zoom || 1) > 1.001 || w !== cropW || h !== cropH;
  ctx.imageSmoothingEnabled = resample;
  if (resample) ctx.imageSmoothingQuality = options.fast ? "medium" : "high";
  // Cropping samples straight from the source rect - the crop is a pixel
  // selection, never a scale-then-recrop, so it never loses sharpness.
  if (video.readyState >= 2) ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, w, h);
  ctx.restore();

  if (options.focusGuide) {
    const guideLocal = toCropLocal(options.focusGuide.x, options.focusGuide.y, crop);
    const gx = w / 2 + (guideLocal.x * w - focus.x) * camera.zoom;
    const gy = h / 2 + (guideLocal.y * h - focus.y) * camera.zoom;
    ctx.beginPath();
    ctx.arc(gx, gy, 22, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(224, 180, 74, 0.9)";
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (options.cursor && options.cursor.style && options.cursor.style !== "none") {
    const cursorLocal = toCropLocal(options.cursor.x, options.cursor.y, crop);
    const cx = w / 2 + (cursorLocal.x * w - focus.x) * camera.zoom;
    const cy = h / 2 + (cursorLocal.y * h - focus.y) * camera.zoom;
    drawCursorGlyph(ctx, options.cursor.style, cx, cy, Boolean(options.cursor.down));
  }
}

export function sourceFromCanvasPoint(camera, canvas, clientX, clientY, crop) {
  const rect = canvas.getBoundingClientRect();
  const sx = ((clientX - rect.left) / rect.width) * canvas.width;
  const sy = ((clientY - rect.top) / rect.height) * canvas.height;
  const w = canvas.width;
  const h = canvas.height;
  const c = normalizeCrop(crop);
  const localCam = toCropLocal(camera.x, camera.y, c);
  const focus = focusPoint({ ...camera, x: localCam.x, y: localCam.y }, w, h);
  const sourceX = (sx - w / 2) / camera.zoom + focus.x;
  const sourceY = (sy - h / 2) / camera.zoom + focus.y;
  return {
    x: clamp(c.x + clamp(sourceX / w, 0, 1) * c.w, 0, 1),
    y: clamp(c.y + clamp(sourceY / h, 0, 1) * c.h, 0, 1)
  };
}
