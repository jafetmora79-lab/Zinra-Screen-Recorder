(() => {
  if (window.__zinraPointer || window.__swoopPointer || window.__moleRecPointer) return;
  window.__zinraPointer = true;
  if (window !== window.top) return;

  const state = { x: 0.5, y: 0.5, down: false, dirty: false, at: 0 };
  let armed = false;
  let raf = 0;
  let lastSent = 0;
  let port = null;

  function clamp01(value) {
    return Math.min(1, Math.max(0, value));
  }

  function connect() {
    try {
      port = chrome.runtime.connect({ name: "zinra-pointer" });
      port.onDisconnect.addListener(() => {
        port = null;
        if (armed) setTimeout(connect, 250);
      });
    } catch {
      port = null;
    }
  }

  function pointFromEvent(event) {
    const w = window.innerWidth || 1;
    const h = window.innerHeight || 1;
    state.x = clamp01(event.clientX / w);
    state.y = clamp01(event.clientY / h);
    state.at = Date.now();
  }

  function send(extra = {}) {
    const payload = {
      type: "pointer",
      x: state.x,
      y: state.y,
      down: state.down,
      at: state.at || Date.now(),
      ...extra
    };
    try {
      if (!port) connect();
      port?.postMessage(payload);
    } catch {
      connect();
      try { port?.postMessage(payload); } catch { /* Extension reloaded. */ }
    }
  }

  function activeBox() {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    const w = window.innerWidth || 1;
    const h = window.innerHeight || 1;
    return {
      x: (r.left + r.width / 2) / w,
      y: (r.top + r.height / 2) / h,
      w: r.width / w,
      h: r.height / h
    };
  }

  function flush() {
    raf = 0;
    if (!armed || !state.dirty) return;
    const now = performance.now();
    if (now - lastSent < 8) {
      raf = requestAnimationFrame(flush);
      return;
    }
    lastSent = now;
    state.dirty = false;
    send();
  }

  function schedule() {
    if (!armed) return;
    state.dirty = true;
    if (!raf) raf = requestAnimationFrame(flush);
  }

  window.addEventListener("mousemove", (event) => {
    if (!armed) return;
    pointFromEvent(event);
    schedule();
  }, { passive: true });

  window.addEventListener("mousedown", (event) => {
    if (!armed) return;
    pointFromEvent(event);
    state.down = true;
    state.dirty = false;
    lastSent = performance.now();
    send({ click: true, button: event.button });
  }, { passive: true });

  window.addEventListener("mouseup", () => {
    if (!armed) return;
    state.down = false;
    send({ click: false });
  }, { passive: true });

  let lastType = 0;
  window.addEventListener("keydown", (event) => {
    if (!armed || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key.length !== 1 && event.key !== "Backspace" && event.key !== "Enter") return;
    const now = performance.now();
    if (now - lastType < 140) return;
    lastType = now;
    send({ kind: "type", box: activeBox() });
  }, { passive: true });

  let lastScroll = 0;
  window.addEventListener("scroll", () => {
    if (!armed) return;
    const now = performance.now();
    if (now - lastScroll < 80) return;
    lastScroll = now;
    send({ kind: "scroll" });
  }, { passive: true, capture: true });

  function arm() {
    armed = true;
    connect();
  }

  function disarm() {
    armed = false;
    state.dirty = false;
    state.down = false;
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    try { port?.disconnect(); } catch { /* ignore */ }
    port = null;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "zinra-arm" || msg?.type === "swoop-arm" || msg?.type === "mole-arm") arm();
    if (msg?.type === "zinra-disarm" || msg?.type === "swoop-disarm" || msg?.type === "mole-disarm") disarm();
  });
  window.addEventListener("zinra-disarm", disarm);

  arm();
})();
