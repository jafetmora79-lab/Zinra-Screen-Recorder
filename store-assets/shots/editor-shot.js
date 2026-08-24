import { openEditor } from "../../editor.js";

function pointerPath() {
  const clicks = [
    { t: 1.15, x: 0.22, y: 0.38 },
    { t: 4.35, x: 0.48, y: 0.42 },
    { t: 8.55, x: 0.63, y: 0.56 }
  ];
  const samples = [];
  for (let t = 0; t <= 14.5; t += 0.08) {
    const next = clicks.find((c) => c.t >= t) || clicks[clicks.length - 1];
    const prev = [...clicks].reverse().find((c) => c.t <= t) || clicks[0];
    const span = Math.max(0.001, next.t - prev.t);
    const u = Math.min(1, Math.max(0, (t - prev.t) / span));
    samples.push({
      t,
      x: prev.x + (next.x - prev.x) * u,
      y: prev.y + (next.y - prev.y) * u,
      down: clicks.some((c) => Math.abs(c.t - t) < 0.05)
    });
  }
  return { clicks, samples };
}

function wait(el, event, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    el.addEventListener(event, () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

const { clicks, samples } = pointerPath();
const blob = await fetch("../../media/zoom-demo.mp4").then((r) => r.blob());

openEditor({
  blob,
  samples,
  clicks,
  focuses: [],
  scrolls: [],
  settings: {
    autoMarkClicks: true,
    clickZoom: 1.5,
    zoomDuration: 2.2,
    quality: "1080p",
    includeAudio: true,
    includeCamera: false,
    clickEffect: "ripple",
    pro: false,
    exportCount: 0,
    background: "solid",
    backgroundColorA: "#1a1916",
    backgroundColorB: "#e0b44a",
    backgroundBlur: "none",
    backgroundPadding: 0
  },
  recordedSeconds: 16.5,
  capture: { displaySurface: "browser" }
});

const video = document.getElementById("sourceVideo");
await wait(video, "loadeddata", 8000);
video.currentTime = 1.45;
await wait(video, "seeked", 2500);
await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
await new Promise((r) => setTimeout(r, 400));

if (new URLSearchParams(location.search).get("overlay") === "export") {
  const overlay = document.getElementById("exportOverlay");
  const status = document.getElementById("exportOverlayStatus");
  const bar = document.getElementById("exportProgressBar");
  overlay?.classList.remove("hidden");
  if (status) status.textContent = "Encoding 1080p · 42%";
  if (bar) bar.style.width = "42%";
}

document.documentElement.dataset.shotReady = "1";
window.__SHOT_READY__ = true;
