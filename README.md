# Zinra

Record a Chrome tab, a window, or your screen. Punch in on clicks when Zinra can see them. Export an MP4 offline: Zinra seeks through the take and encodes each frame. It does not play the clip in real time to re-record it.

## Load it in Chrome

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked** and pick this folder
4. Reload the extension if it was already loaded
5. Open the page you want to film → Zinra → **Record this page**
6. Or **Record my screen** to pick a tab, a window, or a monitor in Chrome’s picker
7. Click **Stop & edit** (opens as a tab next to the page you filmed)

Shortcut: **Alt+Shift+R** starts or stops a take.

Windows: double-click **Install Zinra.bat**. That copies Zinra into `%LOCALAPPDATA%\Zinra` and opens Chrome’s extensions page so you can **Load unpacked**. Chrome does not allow a silent installer that injects an extension; the Web Store is the usual path for other people.

`ZinraSetup.exe` (built from `installer/ZinraSetup.cs`) does the same thing with a GUI, but it’s an unsigned local build, so Windows SmartScreen or your antivirus may block or quarantine it on first run — that’s not a bug, it’s Windows/AV distrusting an unsigned binary. If you hit "Windows cannot access the specified device, path or file" after a security warning, that’s usually AV having blocked or removed it; use **Install Zinra.bat** instead, or check your antivirus’s quarantine/protection history and allow it there.

## How to use

**Record this page** is the usual path. It captures the tab you started from and always tracks clicks there.

**Record my screen** opens Chrome’s share picker:

- **A Chrome tab or a window** — recording works. Auto zoom is best-effort: Zinra follows clicks on whichever Chrome tab currently has focus. Chrome never tells the extension which exact tab or window you picked.
- **Entire screen** — recording works. Auto zoom does **not** run. A click on a page has no reliable position in a desktop-sized frame. Place Zoom clips yourself after you stop.

**Include camera** (popup, off by default) records a webcam bubble with the take. After Stop & edit, drag and resize the circle; it is composited into the export.

Stop with **Stop & edit**, the popup, Alt+Shift+R, or the floating stop pill on the page you were using.

## When automatic zoom works

Auto zoom builds Zoom-track clips from pointer events, not by watching pixels.

It **does** run when:

- **Record this page**, and
- **Record my screen** after you shared a **tab** or a **window**, while you keep clicking in a Chrome tab, and
- the popup checkbox **Mark a zoom on each click** is on (default)

It **does not** run when:

- you shared the **entire screen**
- you turned **Mark a zoom on each click** off
- you clicked outside Chrome (another app, the desktop, Chrome’s own UI chrome)

What it places:

- Left-clicks get a zoom at **1.50×** standard depth (change it in the popup or per clip)
- Nearby clicks (about 1.25s apart and close on the page) become **one** clip
- Far-apart clicks each get their own clip, packed so bars do not overlap
- Typing in a field gets a zoom framed on that field; those clips stay **fixed**, they do not follow the mouse
- You can drag edges, change depth, split at the playhead, delete, or **Rebuild auto zooms**. The Zoom track is the source of truth.

Test it on `playground.html` (also at GitHub Pages: [playground](https://jafetmora79-lab.github.io/Zinra-Screen-Recorder/playground.html)).

## Defaults

- Standard zoom depth is **1.50×**
- Export quality defaults to **1080p** (recording stays at the tab’s native size)
- Fit on the timeline shows the whole take with no left/right scroll

## Editor

- **Left:** Zoom, Speed, Cut, Audio, Camera, Effects, Crop, Background, Trim. After you edit a zoom/speed/cut/audio/trim segment, click **Save** (or Ctrl/Cmd+S)
- **Center:** live preview
- **Bottom:** Video / Zoom / Speed / Cut / Audio tracks. **Fit** keeps long recordings on one screen
- **Top right:** quality selector + Export

Keyboard: Space play/pause, Delete removes the selected segment, Ctrl/Cmd+S saves the current segment.

## Chrome Web Store

See `STORE.md` for listing copy, screenshot notes, privacy hosting, and the Free / Pro plan. Host `privacy.html` at a public HTTPS URL before you submit. How-to copy for the public site lives in `index.html` (`#howto`).

## Notes

- Capture uses the source’s native pixels (up to 4K/60 when Chrome can record MP4 in hardware)
- Export scales down to the quality you pick — it never upscales
- Reload the extension after code changes, then refresh the page you are filming

MP4 muxing uses [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) (MIT).
