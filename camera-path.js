function hypot(x, y) {
  return Math.hypot(x, y);
}

function mix(a, b, u) {
  return a + (b - a) * u;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clusterClicksRaw(clicks, gap = 1.25, radius = 0.1) {
  if (!clicks.length) return [];
  const sorted = [...clicks].sort((a, b) => a.t - b.t);
  const groups = [];
  let group = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = group[group.length - 1];
    const next = sorted[i];
    const near = hypot(next.x - prev.x, next.y - prev.y) <= radius;
    if (next.t - prev.t <= gap && near) group.push(next);
    else {
      groups.push(group);
      group = [next];
    }
  }
  groups.push(group);
  return groups.map((items) => {
    const x = items.reduce((sum, item) => sum + item.x, 0) / items.length;
    const y = items.reduce((sum, item) => sum + item.y, 0) / items.length;
    const spread = items.reduce((max, item) => Math.max(max, hypot(item.x - x, item.y - y)), 0);
    return {
      t: items[0].t,
      end: items[items.length - 1].t,
      x,
      y,
      spread,
      count: items.length
    };
  });
}

function mergeTypeFocuses(focuses, gap = 1.1) {
  if (!focuses?.length) return [];
  const sorted = [...focuses].sort((a, b) => a.t - b.t);
  const groups = [];
  let group = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = group[group.length - 1];
    const next = sorted[i];
    if (next.t - prev.t <= gap && hypot(next.x - prev.x, next.y - prev.y) < 0.08) group.push(next);
    else {
      groups.push(group);
      group = [next];
    }
  }
  groups.push(group);
  return groups.map((items) => {
    const last = items[items.length - 1];
    const w = last.w || 0.2;
    const h = last.h || 0.08;
    return {
      t: items[0].t,
      end: last.t,
      x: last.x,
      y: last.y,
      w,
      h
    };
  });
}

function zoomFromBox(w, h, minZoom, maxZoom) {
  const size = Math.max(w || 0.2, (h || 0.08) * 0.7, 0.08);
  return clamp(0.52 / size, minZoom, maxZoom);
}

function zoomFromSpread(spread, loose, tight) {
  const t = clamp(1 - spread / 0.05, 0, 1);
  return mix(loose, tight, t);
}

// Raw click/type intents, before they're merged into timeline zoom clips.
// These are only signals for *where a zoom should start* - the live clips
// array (edited on the timeline) is the single source of truth for playback.
export function collectIntents(samples, clicks = [], extras = {}, options = {}) {
  const clickZoom = Number(options.clickZoom) || 1.5;
  const tightZoom = Number(options.tightZoom) || Math.min(1.85, clickZoom + 0.25);
  const typeZoomMin = 1.35;
  const typeZoomMax = 1.85;
  const focuses = extras.focuses || [];

  const intents = [];
  for (const cluster of clusterClicksRaw(clicks)) {
    intents.push({
      kind: "click",
      t: cluster.t,
      end: cluster.end,
      x: cluster.x,
      y: cluster.y,
      zoom: zoomFromSpread(cluster.spread, clickZoom, tightZoom)
    });
  }
  for (const box of mergeTypeFocuses(focuses)) {
    intents.push({
      kind: "type",
      t: box.t,
      end: box.end,
      x: box.x,
      y: box.y,
      zoom: zoomFromBox(box.w, box.h, typeZoomMin, typeZoomMax)
    });
  }
  intents.sort((a, b) => a.t - b.t);
  return intents;
}

export function autoZoomClips(samples, clicks, extras = {}, options = {}) {
  const intents = collectIntents(samples, clicks, extras, options);
  const restZoom = Number(options.restZoom) || 1;
  const hold = Math.min(1.65, Math.max(0.9, Number(options.clipHold) || 1.5));
  const seen = [];
  for (const intent of intents) {
    const span = Math.max(0, (intent.end || intent.t) - intent.t);
    const duration = Math.max(hold, span + 0.35);
    const last = seen[seen.length - 1];
    const near = last && hypot(intent.x - last.x, intent.y - last.y) < 0.14;
    const overlaps = last && intent.t < last.start + last.duration + 0.22;
    if (last && overlaps && (near || intent.t < last.start + last.duration * 0.75)) {
      last.duration = Math.max(last.duration, intent.t + duration - last.start);
      last.x = intent.x;
      last.y = intent.y;
      last.zoom = Math.max(last.zoom, intent.zoom);
      continue;
    }
    seen.push({
      id: `z${seen.length}-${Math.random().toString(36).slice(2, 6)}`,
      start: Math.max(0, intent.t),
      duration,
      zoom: intent.zoom,
      x: intent.x,
      y: intent.y,
      followCursor: intent.kind !== "type",
      enabled: true,
      reason: intent.kind
    });
  }
  return packZoomClips(seen.map((clip) => ({
    ...clip,
    zoom: Math.max(clip.zoom, restZoom + 0.15)
  })), 0.22);
}

function packZoomClips(clips, gap) {
  const sorted = [...clips].sort((a, b) => a.start - b.start);
  const out = [];
  for (const clip of sorted) {
    const last = out[out.length - 1];
    if (!last) {
      out.push({ ...clip });
      continue;
    }
    const lastEnd = last.start + last.duration;
    if (clip.start < lastEnd + gap) {
      const near = hypot(clip.x - last.x, clip.y - last.y) < 0.16;
      if (near) {
        last.duration = Math.max(lastEnd, clip.start + clip.duration) - last.start;
        last.x = clip.x;
        last.y = clip.y;
        last.zoom = Math.max(last.zoom, clip.zoom);
        continue;
      }
      last.duration = Math.max(0.45, clip.start - gap - last.start);
    }
    out.push({ ...clip });
  }
  return out;
}
