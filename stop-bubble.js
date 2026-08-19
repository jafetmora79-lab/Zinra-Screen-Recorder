(() => {
  if (window.__zinraStopBubble) return;
  window.__zinraStopBubble = true;

  const host = document.createElement("div");
  host.id = "__zinra-stop-bubble-host";
  host.style.cssText = "all:initial; position:fixed; z-index:2147483647; right:20px; bottom:20px;";
  const shadow = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = `
    .bubble {
      display: flex;
      align-items: center;
      gap: 8px;
      background: #1a1916;
      color: #f3efe6;
      border: 1px solid rgba(243, 239, 230, 0.16);
      border-radius: 999px;
      padding: 8px 14px 8px 10px;
      font: 650 13px "Segoe UI", Inter, system-ui, sans-serif;
      box-shadow: 0 10px 26px rgba(0, 0, 0, 0.45);
      cursor: grab;
      user-select: none;
      touch-action: none;
    }
    .bubble:active { cursor: grabbing; }
    .dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: #c45c4a;
      animation: zinraPulse 1.4s ease-in-out infinite;
      flex: 0 0 auto;
    }
    @keyframes zinraPulse { 50% { opacity: 0.35; } }
    .stop-icon {
      width: 11px;
      height: 11px;
      border-radius: 3px;
      background: #f3efe6;
      flex: 0 0 auto;
    }
    .label { white-space: nowrap; }
  `;

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = `<span class="dot"></span><span class="stop-icon"></span><span class="label">Stop recording</span>`;

  shadow.append(style, bubble);
  document.documentElement.appendChild(host);

  let dragging = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let originRight = 20;
  let originBottom = 20;

  bubble.addEventListener("pointerdown", (event) => {
    dragging = true;
    moved = false;
    startX = event.clientX;
    startY = event.clientY;
    const rect = host.getBoundingClientRect();
    originRight = window.innerWidth - rect.right;
    originBottom = window.innerHeight - rect.bottom;
    try { bubble.setPointerCapture(event.pointerId); } catch { /* ignore */ }
  });

  bubble.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
    if (!moved) return;
    const nextRight = Math.min(Math.max(originRight - dx, 4), window.innerWidth - 40);
    const nextBottom = Math.min(Math.max(originBottom - dy, 4), window.innerHeight - 30);
    host.style.right = `${nextRight}px`;
    host.style.bottom = `${nextBottom}px`;
  });

  function endDrag(event) {
    if (!dragging) return;
    dragging = false;
    try { bubble.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
    if (!moved) {
      chrome.runtime.sendMessage({ type: "zinra-stop-bubble-click" }).catch(() => {});
    }
  }
  bubble.addEventListener("pointerup", endDrag);
  bubble.addEventListener("pointercancel", endDrag);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "zinra-remove-bubble") {
      host.remove();
      window.__zinraStopBubble = false;
    }
  });
})();
