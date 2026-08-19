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

// Every recorded click whose short effect animation window (0 to `duration`
// seconds after the click) covers time t, with 0-1 progress through it.
// A pure function of (clicks, t) like the rest of this module, so it works
// identically whether called during live scrubbing or offline export.
export function activeClickEffects(clicks, t, duration = 0.6) {
  if (!clicks || !clicks.length) return [];
  const active = [];
  for (const click of clicks) {
    const dt = t - click.t;
    if (dt >= 0 && dt <= duration) {
      active.push({ x: click.x, y: click.y, progress: dt / duration });
    }
  }
  return active;
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

// Normalized (0-1) radius: cursor drift smaller than this doesn't retarget
// the camera. Small enough to still catch a deliberate move to a nearby
// element, large enough to absorb hand tremor in the recorded trail.
const DEAD_ZONE = 0.028;

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
      targetX: first.x,
      targetY: first.y,
      alwaysFollow: opts.alwaysFollow,
      cursorTau: opts.cursorTau,
      settle,
      followKey
    };
  }

  for (let time = state.t; time < t; time += dt) {
    const next = Math.min(t, time + dt);
    const raw = cameraTarget(next, clips, samples, opts.alwaysFollow, opts.cursorTau, preferredId);
    // Dead zone: only retarget the spring when the cursor has actually moved
    // somewhere new, not on every micro-jitter in the recorded pointer trail.
    if (Math.hypot(raw.x - state.targetX, raw.y - state.targetY) > DEAD_ZONE) {
      state.targetX = raw.x;
      state.targetY = raw.y;
    }
    stepSpring(state, { x: state.targetX, y: state.targetY, zoom: raw.zoom }, omega, zoomOmega, dt);
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

// Centers on the camera's true target and only pulls back exactly as far as
// needed to keep the zoomed viewport inside the frame - not an approximation
// that pans less than it could, and not one that can show past the edge.
function focusPoint(camera, w, h) {
  const zoom = Math.max(1, camera.zoom || 1);
  const halfW = w / (2 * zoom);
  const halfH = h / (2 * zoom);
  return {
    x: clamp(camera.x * w, halfW, w - halfW),
    y: clamp(camera.y * h, halfH, h - halfH)
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

function colorWithAlpha(hex, alpha) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "");
  if (!m) return `rgba(224, 180, 74, ${alpha})`;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// A quick, tight flash exactly at the origin - gives the eye a precise
// anchor point so ring-only effects (ripple, wave) read as landing right on
// the click instead of just "somewhere near" an expanding circle.
function drawCenterAnchor(ctx, progress, color) {
  const window = 0.22;
  if (progress >= window) return;
  const dotFade = 1 - progress / window;
  ctx.beginPath();
  ctx.arc(0, 0, 3, 0, Math.PI * 2);
  ctx.fillStyle = colorWithAlpha(color, dotFade * 0.95);
  ctx.fill();
}

// progress runs 0 (just clicked) to 1 (effect fully faded) over its window.
export function drawClickEffect(ctx, style, x, y, progress, color, scale = 1) {
  const fade = 1 - progress;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  if (style === "ripple") {
    const r = 6 + progress * 34;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.strokeStyle = colorWithAlpha(color, fade * 0.9);
    ctx.lineWidth = 1 + fade * 3;
    ctx.stroke();
    drawCenterAnchor(ctx, progress, color);
  } else if (style === "wave") {
    for (let i = 0; i < 3; i++) {
      const raw = progress - i * 0.16;
      if (raw <= 0) continue;
      const ringProgress = clamp(raw, 0, 1);
      const r = 5 + ringProgress * 32;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.strokeStyle = colorWithAlpha(color, (1 - ringProgress) * 0.7);
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    drawCenterAnchor(ctx, progress, color);
  } else if (style === "spark") {
    const count = 8;
    const len = 6 + progress * 18;
    const inner = 4 + progress * 6;
    ctx.strokeStyle = colorWithAlpha(color, fade);
    ctx.lineWidth = 2;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
      ctx.lineTo(Math.cos(angle) * (inner + len), Math.sin(angle) * (inner + len));
      ctx.stroke();
    }
    drawCenterAnchor(ctx, progress, color);
  } else if (style === "bloom") {
    const r = 10 + progress * 26;
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    grad.addColorStop(0, colorWithAlpha(color, fade * 0.55));
    grad.addColorStop(1, colorWithAlpha(color, 0));
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    drawCenterAnchor(ctx, progress, color);
  } else if (style === "pop") {
    const bounce = progress < 0.35 ? progress / 0.35 : 1 - ((progress - 0.35) / 0.65) * 0.4;
    const dotR = 4 + bounce * 10;
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(1, dotR), 0, Math.PI * 2);
    ctx.fillStyle = colorWithAlpha(color, fade);
    ctx.fill();
    const ringR = 8 + progress * 22;
    ctx.beginPath();
    ctx.arc(0, 0, ringR, 0, Math.PI * 2);
    ctx.strokeStyle = colorWithAlpha(color, fade * 0.6);
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  ctx.restore();
}

// Fills the full w x h canvas behind the (possibly inset) video: a flat
// color, a two-color gradient, or a softened cover-fit copy of the current
// frame itself. blurPx applies to whichever style is active - it's a no-op
// look for a flat color but softens gradient banding and is the whole point
// for "blurred". Overfills by the blur radius so a blurred edge never peeks
// past the canvas boundary.
function drawBackground(ctx, video, bg, w, h, cropX, cropY, cropW, cropH) {
  const blurPx = Math.max(0, Number(bg?.blurPx) || 0);
  if (bg?.style === "blurred" && video.readyState >= 2) {
    ctx.save();
    ctx.filter = blurPx > 0 ? `blur(${blurPx}px) brightness(0.82)` : "brightness(0.82)";
    const scale = Math.max(w / cropW, h / cropH) * 1.15;
    const dw = cropW * scale;
    const dh = cropH * scale;
    ctx.drawImage(video, cropX, cropY, cropW, cropH, (w - dw) / 2, (h - dh) / 2, dw, dh);
    ctx.restore();
    return;
  }
  const colorA = bg?.colorA || "#1a1916";
  const colorB = bg?.colorB || colorA;
  ctx.save();
  if (blurPx > 0) ctx.filter = `blur(${blurPx}px)`;
  if (bg?.style === "gradient") {
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, colorA);
    grad.addColorStop(1, colorB);
    ctx.fillStyle = grad;
  } else {
    ctx.fillStyle = colorA;
  }
  const pad = blurPx * 2;
  ctx.fillRect(-pad, -pad, w + pad * 2, h + pad * 2);
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

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  drawBackground(ctx, video, options.background, w, h, cropX, cropY, cropW, cropH);

  // Padding insets the video within the canvas so the background shows
  // around it. At padding 0 this is an identity offset - iw/ih equal w/h
  // and every downstream calculation below is exactly what it was before.
  const padding = clamp(options.background?.padding || 0, 0, 0.35);
  const insetX = w * padding;
  const insetY = h * padding;
  const iw = w - insetX * 2;
  const ih = h - insetY * 2;

  const localCam = toCropLocal(camera.x, camera.y, crop);
  const focus = focusPoint({ ...camera, x: localCam.x, y: localCam.y }, iw, ih);

  ctx.save();
  ctx.translate(insetX, insetY);
  if (padding > 0) {
    ctx.beginPath();
    ctx.rect(0, 0, iw, ih);
    ctx.clip();
  }
  ctx.save();
  ctx.translate(iw / 2, ih / 2);
  ctx.scale(camera.zoom, camera.zoom);
  ctx.translate(-focus.x, -focus.y);
  // 1:1 copy stays pixel-sharp; zoom or downscale uses high-quality resampling.
  const resample = (camera.zoom || 1) > 1.001 || iw !== cropW || ih !== cropH;
  ctx.imageSmoothingEnabled = resample;
  if (resample) ctx.imageSmoothingQuality = options.fast ? "medium" : "high";
  // Cropping samples straight from the source rect - the crop is a pixel
  // selection, never a scale-then-recrop, so it never loses sharpness.
  if (video.readyState >= 2) ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, iw, ih);
  ctx.restore();

  const overlayScale = Math.max(0.9, Math.min(iw, ih) / 1080);

  if (options.focusGuide) {
    const guideLocal = toCropLocal(options.focusGuide.x, options.focusGuide.y, crop);
    const gx = iw / 2 + (guideLocal.x * iw - focus.x) * camera.zoom;
    const gy = ih / 2 + (guideLocal.y * ih - focus.y) * camera.zoom;
    ctx.beginPath();
    ctx.arc(gx, gy, 22 * overlayScale, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(224, 180, 74, 0.9)";
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (options.clickEffects && options.clickEffects.length && options.clickStyle && options.clickStyle !== "none") {
    for (const effect of options.clickEffects) {
      const local = toCropLocal(effect.x, effect.y, crop);
      const ex = iw / 2 + (local.x * iw - focus.x) * camera.zoom;
      const ey = ih / 2 + (local.y * ih - focus.y) * camera.zoom;
      drawClickEffect(ctx, options.clickStyle, ex, ey, effect.progress, options.clickColor || "#e0b44a", overlayScale);
    }
  }

  ctx.restore();
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
