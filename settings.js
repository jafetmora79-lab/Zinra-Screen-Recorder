export const DEFAULTS = {
  clickZoom: 1.5,
  zoomDuration: 2.2,
  autoMarkClicks: true,
  includeAudio: true,
  quality: "1080p",
  clickEffect: "none",
  pro: false,
  licenseKey: null,
  exportCount: 0,
  // Background shows in the padding around the recording. "solid" only uses
  // colorA; "gradient" blends colorA -> colorB; "blurred" ignores both and
  // uses a softened cover-fit copy of the recording itself.
  background: "solid",
  backgroundColorA: "#1a1916",
  backgroundColorB: "#e0b44a",
  backgroundBlur: "none",
  backgroundPadding: 0
};

// Free accounts get a fixed number of exports total, then need a license
// to keep exporting. Recording and editing stay unlimited either way -
// only the export step is gated.
export const FREE_EXPORT_LIMIT = 2;

export const ENFORCE_PRO = true;

export const QUALITY_PRESETS = {
  auto: { id: "auto", label: "Match recording", maxHeight: Infinity, fps: null, pro: false },
  "720p": { id: "720p", label: "720p", maxHeight: 720, fps: 30, pro: false },
  "1080p": { id: "1080p", label: "1080p", maxHeight: 1080, fps: 30, pro: false },
  "1080p60": { id: "1080p60", label: "1080p · 60fps", maxHeight: 1080, fps: 60, pro: true },
  "1440p": { id: "1440p", label: "1440p", maxHeight: 1440, fps: 30, pro: true },
  "4k": { id: "4k", label: "4K", maxHeight: 2160, fps: 30, pro: true }
};

// A short animation that plays at each recorded click position.
export const CLICK_EFFECTS = {
  none: { id: "none", label: "None", pro: false },
  ripple: { id: "ripple", label: "Ripple", pro: false },
  wave: { id: "wave", label: "Wave", pro: true },
  spark: { id: "spark", label: "Spark", pro: true }
};

export const BACKGROUND_STYLES = {
  solid: { id: "solid", label: "Solid" },
  gradient: { id: "gradient", label: "Gradient" },
  blurred: { id: "blurred", label: "Blurred" }
};

// One-click block-color swatches, straight from the brand palette.
export const BACKGROUND_COLOR_PRESETS = [
  { id: "graphite", label: "Graphite", color: "#1a1916" },
  { id: "ivory", label: "Ivory", color: "#f3efe6" },
  { id: "saffron", label: "Saffron", color: "#e0b44a" },
  { id: "steel", label: "Steel", color: "#5b7c99" },
  { id: "leaf", label: "Leaf", color: "#6a8f62" },
  { id: "clay", label: "Clay", color: "#c45c4a" }
];

// One-click two-color gradient swatches, also from the brand palette.
export const BACKGROUND_GRADIENT_PRESETS = [
  { id: "saffron-clay", label: "Saffron Glow", a: "#e0b44a", b: "#c45c4a" },
  { id: "steel-graphite", label: "Steel Dusk", a: "#5b7c99", b: "#1a1916" },
  { id: "leaf-graphite", label: "Leaf Fade", a: "#6a8f62", b: "#1a1916" },
  { id: "steel-clay", label: "Twilight", a: "#5b7c99", b: "#c45c4a" },
  { id: "ivory-dust", label: "Ivory Mist", a: "#f3efe6", b: "#9a9386" }
];

// px values are tuned for a 1080p-4K canvas - "complete" reads as a soft,
// fully abstract wash rather than a recognizable blurred image.
export const BLUR_LEVELS = {
  none: { id: "none", label: "None", px: 0 },
  small: { id: "small", label: "Small", px: 16 },
  heavy: { id: "heavy", label: "Heavy", px: 40 },
  complete: { id: "complete", label: "Complete", px: 80 }
};

const LEGACY_ZOOM = new Set([1.85, 1.8, 1.7]);
const HEX_RE = /^#[0-9a-f]{6}$/i;

export function migrateSettings(stored = {}) {
  const next = { ...DEFAULTS, ...stored };
  const zoom = Number(next.clickZoom);
  if (LEGACY_ZOOM.has(zoom)) next.clickZoom = DEFAULTS.clickZoom;
  if (!QUALITY_PRESETS[next.quality]) next.quality = DEFAULTS.quality;
  if (!CLICK_EFFECTS[next.clickEffect]) next.clickEffect = DEFAULTS.clickEffect;
  if (!BACKGROUND_STYLES[next.background]) next.background = DEFAULTS.background;
  if (!HEX_RE.test(next.backgroundColorA || "")) next.backgroundColorA = DEFAULTS.backgroundColorA;
  if (!HEX_RE.test(next.backgroundColorB || "")) next.backgroundColorB = DEFAULTS.backgroundColorB;
  if (!BLUR_LEVELS[next.backgroundBlur]) next.backgroundBlur = DEFAULTS.backgroundBlur;
  const padding = Number(next.backgroundPadding);
  next.backgroundPadding = Number.isFinite(padding) ? Math.min(0.35, Math.max(0, padding)) : 0;
  next.pro = Boolean(next.pro);
  const count = Number(next.exportCount);
  next.exportCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  return next;
}

export function isProLocked(id, settings, registry = QUALITY_PRESETS) {
  if (!ENFORCE_PRO) return false;
  const preset = registry[id];
  return Boolean(preset?.pro) && !settings?.pro;
}

export function remainingFreeExports(settings) {
  return Math.max(0, FREE_EXPORT_LIMIT - (Number(settings?.exportCount) || 0));
}

export function canExport(settings) {
  if (!ENFORCE_PRO) return true;
  return Boolean(settings?.pro) || remainingFreeExports(settings) > 0;
}
