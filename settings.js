export const DEFAULTS = {
  clickZoom: 1.5,
  zoomDuration: 2.2,
  autoMarkClicks: true,
  includeAudio: true,
  quality: "1080p",
  cursorStyle: "none",
  cursorColor: "#e0b44a",
  pro: false
};

// Flip this when Chrome Web Store billing / license keys ship.
export const ENFORCE_PRO = false;

export const QUALITY_PRESETS = {
  auto: { id: "auto", label: "Match recording", maxHeight: Infinity, fps: null, pro: false },
  "720p": { id: "720p", label: "720p", maxHeight: 720, fps: 30, pro: false },
  "1080p": { id: "1080p", label: "1080p", maxHeight: 1080, fps: 30, pro: false },
  "1080p60": { id: "1080p60", label: "1080p · 60fps", maxHeight: 1080, fps: 60, pro: true },
  "1440p": { id: "1440p", label: "1440p", maxHeight: 1440, fps: 30, pro: true },
  "4k": { id: "4k", label: "4K", maxHeight: 2160, fps: 30, pro: true }
};

// The recording has no visible OS cursor (tab capture records page pixels,
// not the desktop), so this draws a synthetic one from the tracked pointer.
export const CURSOR_STYLES = {
  none: { id: "none", label: "Hidden", pro: false },
  arrow: { id: "arrow", label: "Arrow", pro: false },
  dot: { id: "dot", label: "Dot", pro: false },
  spotlight: { id: "spotlight", label: "Spotlight", pro: false },
  hand: { id: "hand", label: "Hand", pro: true },
  ring: { id: "ring", label: "Ring", pro: true },
  crosshair: { id: "crosshair", label: "Crosshair", pro: true }
};

function isHexColor(value) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

const LEGACY_ZOOM = new Set([1.85, 1.8, 1.7]);

export function migrateSettings(stored = {}) {
  const next = { ...DEFAULTS, ...stored };
  const zoom = Number(next.clickZoom);
  if (LEGACY_ZOOM.has(zoom)) next.clickZoom = DEFAULTS.clickZoom;
  if (!QUALITY_PRESETS[next.quality]) next.quality = DEFAULTS.quality;
  if (!CURSOR_STYLES[next.cursorStyle]) next.cursorStyle = DEFAULTS.cursorStyle;
  if (!isHexColor(next.cursorColor)) next.cursorColor = DEFAULTS.cursorColor;
  return next;
}

export function isProLocked(id, settings, registry = QUALITY_PRESETS) {
  if (!ENFORCE_PRO) return false;
  const preset = registry[id];
  return Boolean(preset?.pro) && !settings?.pro;
}
