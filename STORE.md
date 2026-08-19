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
• 2 free exports, no account needed

Pro — $7/month or $49/year
• Unlimited exports
• 1440p and 4K export, 60fps export
• Wave and Spark click effects
• Keep using the same editor

Privacy: recordings stay on your machine. Host the repo on GitHub Pages, then paste `https://jafetmora79-lab.github.io/Zinra-Screen-Recorder/privacy.html` into the store listing. The marketing site is `index.html` at the same origin.

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
- **`desktopCapture`** — opens Chrome’s screen/window/tab picker from the popup so Record my screen does not need a second Zinra tab just to pick a source. The recording still stays on the machine.
- Camera access uses the normal browser `getUserMedia` prompt, only when the user turns on **Include camera**. Nothing is uploaded.

## Store checklist

1. Turn on GitHub Pages: repo **Settings → Pages → Deploy from a branch → `main` → `/` (root)**. The site is `https://jafetmora79-lab.github.io/Zinra-Screen-Recorder/` and the privacy URL is that path plus `privacy.html`.
2. When the Chrome Web Store listing is live, paste the store URL into `STORE_URL` at the bottom of `index.html` so every Get Zinra button points at it.
3. Set Privacy policy URL on the listing to the GitHub Pages `privacy.html` URL.
4. Bump the version in `manifest.json`, then run `installer\build-store-package.bat` — it packages just the runtime files (no installer, docs, or unused brand assets) into `dist\zinra-<version>.zip`
5. Load unpacked from `dist\zinra-package`, record a demo, capture screenshots
6. Set support email
7. Submit `dist\zinra-<version>.zip`. Do not mention other products in the listing.

## Monetization plan

Record and edit are unlimited on Free. Exporting is the gate.

**Free**
- Record + editor, no account
- 2 exports total, then Pro is required to export more
- Up to 1080p 30fps, Ripple click effect

**Pro — $7 / month or $49 / year**
- Unlimited exports
- 1080p60, 1440p, 4K
- Wave, Spark click effects
- Future: saved presets, batch export

**Status: `ENFORCE_PRO` is now `true`** — the gates are live in code (`settings.js`: `FREE_EXPORT_LIMIT`, `canExport`, `isProLocked`). What's still missing before this can actually make money:

1. **A real Lemon Squeezy product.** Create a Zinra product at lemonsqueezy.com with two variants (Monthly $7, Yearly $49), turn on **license keys** for it (Product → License Keys). The extension's paywall (`editor.js` → `activateLicense`) already calls Lemon Squeezy's public License API (`/v1/licenses/activate`) — no code change needed once the product exists, any key it issues will just work.
2. **A checkout link.** The live buy URL is in `paywallBuyBtn` in `recorder.html`: `https://zinrastudio.lemonsqueezy.com/checkout/buy/cdd0e3e2-4aff-4205-ba10-fe7e80917d15`
3. **Delivering the key after purchase.** Lemon Squeezy emails the license key automatically on purchase — the buyer pastes it into the paywall's “License key” field, which activates it and sets `pro: true` in `chrome.storage.sync`. No extra delivery mechanism needed.

Do not put a credit-card form inside the extension itself — Lemon Squeezy's hosted checkout handles payment entirely outside the extension.
