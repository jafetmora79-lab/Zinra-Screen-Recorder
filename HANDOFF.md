# Zinra — Handoff Doc

Continuing this project in Cursor. Everything below reflects the state as of commit `e28d473` on `main`, pushed to `https://github.com/jafetmora79-lab/Zinra-Screen-Recorder`.

## What Zinra is

A Chrome extension (Manifest V3) screen recorder: captures a tab or the whole screen, auto-detects "punch-in" zoom moments from clicks/typing, and gives you a timeline editor (zoom, speed, cut, audio, click effects, crop, background, trim) before an **offline** MP4 export via WebCodecs — no server, nothing uploads. Monetization is Lemon Squeezy license keys gating exports past a 2-export free tier (billing not live yet — see Business checklist below).

- Repo root = extension root. Load unpacked via `chrome://extensions` → Developer mode → Load unpacked → this folder.
- **After pulling new code you must reload the extension in `chrome://extensions` (and often close/reopen any open recorder tabs) before testing.** This bit us more than once this session — a "still broken" report turned out to be testing a stale load.
- Public site: `index.html` / `privacy.html` / `playground.html` / `demo.html`, served via GitHub Pages at `https://jafetmora79-lab.github.io/Zinra-Screen-Recorder/`. `playground.html` is the original (non-Cursorful-copied) "try it here" page linked from the install panel.

## Architecture

**Recording start (two modes):**
- Click extension icon → `popup.html`/`popup.js` → two buttons: **"Record this page"** (tab capture) and **"Record my screen"** (screen/window/tab via `getDisplayMedia`).
- Both send `{type:"start", tabId, mode}` to `background.js`'s `startRecording(tabId, mode)`, which opens `recorder.html?tab=<id>&mode=<tab|screen>` in a new tab and tracks state (`recordingTabId` for tab mode, `screenOriginTabId` for screen mode, `recorderTabId` either way).
- **Tab mode**: auto-starts via `chrome.tabCapture.getMediaStreamId` on load, content script (`content.js`) armed immediately for click/pointer tracking.
- **Screen mode**: cannot auto-start — `getDisplayMedia` requires a real user gesture in a durable page (the popup can't hold it; it closes on blur). `recorder.js` shows a "Share your screen" button (auto-focused so Enter/Space works) instead of attempting tab capture.
- After the stream starts, `stream.getVideoTracks()[0].getSettings().displaySurface` tells you `"monitor"` / `"window"` / `"browser"` — **only `"monitor"` (entire screen) skips click-tracking**; window/tab shares get best-effort tracking on whichever tab currently has focus, re-targeted live via `chrome.tabs.onActivated` (see `retargetScreenTracking` in `background.js`). Chrome deliberately never tells the extension *which* window/tab was picked, so this is a heuristic, not a guarantee.
- Once recording starts, focus returns to wherever the user was (`recordingTabId` or `screenOriginTabId`), and `stop-bubble.js` gets injected there (and re-injected on tab switches while `recordingLive`) — a small closed-shadow-DOM draggable pill, click to stop (routes to the same `stopRecording()` as the popup button / Alt+Shift+R).

**Editing/export:** `editor.js` (huge, ~1700+ lines) drives the timeline UI; `compositor.js` has the pure `drawFrame`/`cameraAt`/spring-camera math shared by live preview and export; `export-render.js` does the actual offline WebCodecs render loop (seek → draw → `getImageData` → I420 → `VideoEncoder`); `camera-path.js` has the auto-zoom-clip detection (`autoZoomClips`, working off `reason: "click"|"type"` — **not** a 6-category taxonomy, despite what the playground's demo tiles might suggest); `settings.js` is the single source of truth for defaults/presets/migration.

## What happened this session (reverse chronological, most recent first)

1. **Export bug fix** (`e28d473`) — `seekTo()` in `export-render.js` resolved on a blind 70ms timeout with no guarantee the video had actually decoded to that position. On a slow seek, `drawFrame()` would skip the video draw (since it gates on `video.readyState >= 2`) and encode just the background fill for that frame — a flash of whatever background color was last set (user reported green bars in an uploaded video; likely a leftover "Leaf" `#6a8f62` swatch from testing). Fixed: `seekTo` now polls up to ~300ms past the seek event for real ready state, and the main loop reuses the previous frame's pixels rather than redrawing blank if still not ready. **Not yet confirmed by the user against a fresh export** — that's the first thing to check.

2. **Screen-picker + click-tracking fixes** (`1916ff1`, `13f78b0`) — `getDisplayStream()` had `preferCurrentTab: true`, which (since it's called from *inside* the recorder tab) biased Chrome's picker toward sharing Zinra's own blank editor page, forcing a decline-then-repick loop. Removed. Also added `displaySurface`-based click tracking for window/tab shares (see Architecture above) and focused the "Share your screen" button.

3. **Whole-screen recording + stop bubble** (`aee2f23`, `cd0ee82`, `941fbbf`, `af1740d`) — added the second popup button and the `mode=screen` path end to end; fixed a real CSS bug where `.editor-stage`/`.stage-frame`/`.viewport` used `place-items:center`, which left their implicit grid row `auto`-sized instead of stretching to the container, so `max-height:100%` never resolved and the video preview could overflow its box by 2x on shorter windows (root-caused by literally drawing a bordered test pattern into the canvas and measuring); redesigned editor visual identity (pinched-hexagon zoom clips colored by track, empty-track dimming, Background panel's Blur section grays out unless Style is "Blurred", live numeric padding input, mono mismatch trained on plain window resize); added the floating draggable stop-bubble (`stop-bubble.js`, closed shadow DOM). **The user has not yet confirmed the stop bubble actually appears in real usage** — flagged as possibly just needing a reload, unconfirmed either way.

4. **Landing/marketing polish, cursor-feature removal, background/blur editor feature** (`4a5f3f2` and earlier through `8b0b89a`) — a synthetic-cursor-overlay feature was fully ripped out per explicit user instruction after a long, frustrating misdiagnosis saga (the real root cause had been a missing `cursor:"never"` constraint on `getDisplayMedia`, found via WebSearch, but the user had lost patience with the whole approach by the time it was fixed — don't resurrect this feature without being asked). Replaced with a Background panel (solid/gradient/blurred fill with none/small/heavy/complete blur, padding inset) and 2 new Pro click effects (Bloom, Pop) plus a center-anchor flash on Ripple/Wave so they read as landing precisely on the click.

## Known unconfirmed / needs-testing items (start here)

- [ ] **Export green-frame fix** — re-export a recording, confirm no more flash artifacts.
- [ ] **Stop bubble** — confirm it actually renders (a small dark pill, bottom-right, draggable, "Stop recording") on the page you land on after starting a recording, not just Chrome's native sharing bar.
- [ ] **Screen-mode click tracking** — record by sharing "This Tab" or a window (not Entire Screen), click around, confirm Zoom clips show up on the timeline afterward.
- [ ] The click-testing/drag-testing of `stop-bubble.js` in this session was done via a mocked `chrome.runtime` in a plain HTML page — visual render and hit-testing position were confirmed correct, but the actual click-to-stop-message path could not be verified end-to-end (the browser automation tool used couldn't simulate a real pointer event landing inside the closed shadow DOM). Worth a manual click test.

## Next task queued up (not started)

**Camera/webcam picture-in-picture bubble** — requested by the user after seeing Cursorful's "Select camera" option. Scope: `getUserMedia({video:true})` for a webcam stream, a draggable/resizable circular overlay in the live preview, composited into both the live canvas and `export-render.js`'s offline render loop. Touches `recorder.js`, `compositor.js`, `editor.js`, and probably a new panel in `recorder.html`/`ui.css`. Not started — no code written for this yet.

## Business / monetization checklist (unchanged from before this session, still open)

See `STORE.md` for full detail. Summary:
1. Chrome Web Store developer account — user was mid-registration (payment profile, identity verification) in an earlier session; confirm it's done.
2. Create the Lemon Squeezy product (Monthly $7 / Yearly $49 variants), turn on License Keys — no code changes needed once it exists, `editor.js`'s `activateLicense` already calls the public License API.
3. Paste the real checkout URL into `paywallBuyBtn`'s href in `recorder.html` (currently a placeholder pointing at the landing page's pricing anchor).
4. Store listing assets (screenshots, description — already drafted, see earlier STORE.md), privacy URL (already live), support email.
5. Bump `manifest.json` version, run `installer\build-store-package.bat`, submit.
6. Once approved, paste the store URL into `STORE_URL` in `index.html`.

## Design/brand reference

Graphite `#1a1916`, Ivory `#f3efe6`, Saffron `#e0b44a` (primary accent), Steel `#5b7c99`, Leaf `#6a8f62`, Clay `#c45c4a`, Bronze `#b98a4e`. Body/UI font is Inter (now actually loaded via Google Fonts in `recorder.html` — it wasn't for most of this project's life despite being in the CSS font stack, silently falling back to Segoe UI). Mono display font (`Cascadia Mono`/`JetBrains Mono`) used for panel kickers, timestamps, eyebrows. Full palette and "don't use" list (avoid teal/mint, avoid anything Cursorful-associated) in `BRAND.md`. Voice is direct, a little irreverent — see `playground.html`'s copy for the reference tone.

## Gotchas worth knowing before touching this codebase

- **`min-width: auto` / `min-height: auto` on flex/grid children is the recurring root cause this session** — it silently blocks shrinking below content size and causes overflow that's invisible (no scrollbar, just clipped or pushed off-edge). Any time something "doesn't fit," check for this before assuming it's something exotic.
- **A single implicit grid row/column with `place-items: center` doesn't stretch to the container's own size** — it sizes to content instead, which breaks any percentage-height chain running through it. Use explicit `grid-template-rows/columns: minmax(0, 1fr)` instead when you need the item to actually fill the box.
- **`getDisplayMedia` needs a real user gesture in a durable page** — can't be triggered from a popup (closes on blur) or auto-triggered on page load. This is a hard platform constraint, not a Zinra shortcoming — Cursorful hits the identical requirement (visible in their own screenshots: real tab, real second click, then the picker).
- **Chrome never tells the extension which screen/window/tab was actually picked** in the `getDisplayMedia` picker, for privacy. `displaySurface` on the track settings tells you the *type* (monitor/window/browser) but never the specific source — any "what's being recorded" logic has to work around that opacity.
