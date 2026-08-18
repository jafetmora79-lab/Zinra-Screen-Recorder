# Zinra

Record a Chrome tab, punch in on clicks, then export an MP4. Export is offline: Zinra seeks through the take and encodes each frame. It does not play the clip in real time to re-record it.

## Load it in Chrome

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked** and pick this folder
4. Reload the extension if it was already loaded
5. Open the page you want to film → Zinra → **Record this page**
6. Click **Stop & edit** (opens as a tab next to the page you filmed)

Shortcut: **Alt+Shift+R** starts or stops a take.

Windows: double-click **Install Zinra.bat**. That copies Zinra into `%LOCALAPPDATA%\Zinra` and opens Chrome’s extensions page so you can **Load unpacked**. Chrome does not allow a silent installer that injects an extension; the Web Store is the usual path for other people.

`ZinraSetup.exe` (built from `installer/ZinraSetup.cs`) does the same thing with a GUI, but it’s an unsigned local build, so Windows SmartScreen or your antivirus may block or quarantine it on first run — that’s not a bug, it’s Windows/AV distrusting an unsigned binary. If you hit "Windows cannot access the specified device, path or file" after a security warning, that’s usually AV having blocked or removed it; use **Install Zinra.bat** instead, or check your antivirus’s quarantine/protection history and allow it there.

## Defaults

- Standard zoom depth is **1.50×**
- Export quality defaults to **1080p** (recording stays at the tab’s native size)
- Fit on the timeline shows the whole take with no left/right scroll

## Editor

- **Left:** Zoom, Speed, Cut, Motion, and Trim. After you edit a segment, click **Save** (or Ctrl/Cmd+S)
- **Center:** live preview
- **Bottom:** Video / Zoom / Speed / Cut tracks. **Fit** keeps long recordings on one screen
- **Top right:** quality selector + Export

Nearby clicks become one zoom. Separate clicks get their own clip with a short gap so bars do not overlap.

Keyboard: Space play/pause, Delete removes the selected segment, Ctrl/Cmd+S saves the current segment.

## Chrome Web Store

See `STORE.md` for listing copy, screenshot notes, privacy hosting, and the Free / Pro plan. Host `privacy.html` at a public HTTPS URL before you submit.

## Notes

- Capture uses the tab’s native pixels (up to 4K/60 when Chrome can record MP4 in hardware)
- Export scales down to the quality you pick — it never upscales
- Reload the extension after code changes, then refresh the page you are filming

MP4 muxing uses [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) (MIT).
