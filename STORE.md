# Chrome Web Store + monetization

## Listing (paste into CWS)

**Name:** Zinra  
**Short:** Record a tab. Punch in on clicks. Export an MP4.  
**Category:** Productivity  
**Language:** English

**Description:**

Zinra records the page you are on, then opens a timeline so you can punch in on clicks, speed sections up or down, and cut dead time. Export is offline: Zinra seeks through the take and encodes each frame. It does not play the clip in real time to re-record it.

Free
• Tab recording with optional audio
• Auto zoom on clicks (Standard 1.50×)
• Zoom, speed, cut, and trim
• Add your own voiceover or music track in the editor
• Export up to 1080p

Pro (when billing ships)
• 1440p and 4K export
• 60fps export
• Keep using the same editor

Privacy: recordings stay on your machine. See privacy.html (host this page at a public HTTPS URL and paste that URL into the store listing).

**Single purpose:** Screen recording and timeline editing for Chrome tabs.

## Assets

- Extension icons: `icons/icon16.png`, `icon48.png`, `icon128.png` (from `app_icon_1024.png`)
- Store icon: `icons/app_icon_1024.png` (also upload 128)
- Screenshots: 1280×800 of popup, recorder, editor with a zoom clip selected, export dialog
- Promotional tile (optional): 440×280 graphite + saffron mark + “Record. Punch in. Export.”

## Permission justification (paste into the CWS review form)

- **`tabCapture`** — records the tab the user starts recording from.
- **`host_permissions: <all_urls>` + `scripting`** — Zinra records whatever page the user is currently on, which could be any site, so the pointer-tracking helper (`content.js`) has to be injectable on any host. It's only injected into the one tab a user explicitly starts recording, and only for the duration of that recording.
- **`tabs` / `activeTab`** — find the active tab to record and bring the editor tab forward.
- **`storage`** — remember zoom/quality/audio preferences locally (`chrome.storage.sync`), nothing is uploaded.
- **`downloads`** — save the exported MP4 where the user picks.

## Store checklist

1. Host `privacy.html` (GitHub Pages is enough) and set Privacy policy URL
2. Bump the version in `manifest.json`, then run `installer\build-store-package.bat` — it packages just the runtime files (no installer, docs, or unused brand assets) into `dist\zinra-<version>.zip`
3. Load unpacked from `dist\zinra-package`, record a demo, capture screenshots
4. Set support email
5. Submit `dist\zinra-<version>.zip`. Do not mention other products in the listing.

## Monetization plan

Ship Free on the store first. Pro is already labeled in the quality menu; `ENFORCE_PRO` in `settings.js` is **false** so demos and the first listing are unlocked.

**Free forever**
- Record + editor
- Export 720p / 1080p 30fps
- Standard 1.50× zoom

**Pro — $7 / month or $49 / year**
- 1080p60, 1440p, 4K
- Future: saved presets, batch export

**How to charge (after listing is live)**
1. Stripe Checkout or Lemon Squeezy for a license key
2. Store the key in `chrome.storage.sync` (`pro: true`)
3. Set `ENFORCE_PRO = true`
4. Locked qualities show the Pro badge and a short “Unlock Pro” note — no fake paywall in the first release

Do not put a credit-card form inside the extension. Open a checkout tab. Keep the editor usable on Free so the listing does not feel gated.
