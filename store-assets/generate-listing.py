#!/usr/bin/env python3
"""Render Chrome Web Store listing assets.

Promo tiles are drawn here. Screenshots are captured from store-assets/shots/
via headless Chrome (1280x800, 24-bit PNG, no alpha).
"""

from __future__ import annotations

import json
import os
import subprocess
import time
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(__file__).resolve().parent
SHOTS = OUT / "shots"
FONT_DIR = Path("/usr/share/fonts/truetype/macos")
GRAPHITE = (26, 25, 22)
GRAPHITE_2 = (35, 33, 29)
IVORY = (243, 239, 230)
DUST = (154, 147, 134)
SAFFRON = (224, 180, 74)


def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONT_DIR / name), size)


def measure(draw: ImageDraw.ImageDraw, text: str, fnt: ImageFont.FreeTypeFont):
    box = draw.textbbox((0, 0), text, font=fnt)
    return box[2] - box[0], box[3] - box[1]


def draw_mark(draw: ImageDraw.ImageDraw, x: int, y: int, size: int, stroke: int):
    scale = size / 32.0

    def rect(x0, y0, w, h, rx):
        draw.rounded_rectangle(
            [x + x0 * scale, y + y0 * scale, x + (x0 + w) * scale, y + (y0 + h) * scale],
            radius=max(2, rx * scale),
            outline=SAFFRON,
            width=stroke,
        )

    rect(3.5, 5.5, 20, 15, 3.5)
    rect(8.5, 11.5, 20, 15, 3.5)


def save_rgb(im: Image.Image, path: Path):
    im.convert("RGB").save(path, "PNG")
    print(f"wrote {path.relative_to(ROOT)} {im.size}")


SLOGAN = "Zoom that follows the click."
SUPPORT = "Record a tab or screen. The MP4 never leaves your machine."


def draw_wordmark(draw, x, y, word_size, studio_size):
    """Zinra + Studio on one baseline. Returns (width, height, baseline_y)."""
    word = font("Inter-Bold.ttf", word_size)
    studio = font("Inter-Medium.ttf", studio_size)
    word_box = draw.textbbox((0, 0), "Zinra", font=word)
    studio_box = draw.textbbox((0, 0), "Studio", font=studio)
    word_w, word_h = word_box[2] - word_box[0], word_box[3] - word_box[1]
    studio_w = studio_box[2] - studio_box[0]
    gap = max(10, word_size // 5)
    # Shared baseline so Studio sits beside Zinra, not under it.
    baseline = y + word_h
    draw.text((x, baseline), "Zinra", font=word, fill=IVORY, anchor="ls")
    draw.text((x + word_w + gap, baseline), "Studio", font=studio, fill=DUST, anchor="ls")
    return word_w + gap + studio_w, word_h, baseline


def promo_small():
    w, h = 440, 280
    im = Image.new("RGB", (w, h), GRAPHITE)
    draw = ImageDraw.Draw(im)
    draw.rectangle((0, 0, w, 3), fill=SAFFRON)

    tag = font("Inter-Medium.ttf", 17)
    mark = 64
    word_size = 40
    # Measure lockup before placing so the block can sit in the optical center.
    probe = ImageDraw.Draw(Image.new("RGB", (w, h), GRAPHITE))
    lockup_w, lockup_h, _ = draw_wordmark(probe, 0, 0, word_size, 22)
    tag_w, tag_h = measure(draw, SLOGAN, tag)
    rule_w = min(72, tag_w)
    block_w = max(mark + 14 + lockup_w, tag_w)
    block_h = max(mark, lockup_h) + 18 + 1 + 16 + tag_h
    left = (w - block_w) // 2
    top = (h - block_h) // 2 + 4

    draw_mark(draw, left, top + (max(mark, lockup_h) - mark) // 2, mark, 3)
    draw_wordmark(draw, left + mark + 14, top + (max(mark, lockup_h) - lockup_h) // 2, word_size, 22)

    rule_y = top + max(mark, lockup_h) + 18
    rule_x = (w - rule_w) // 2
    draw.rectangle((rule_x, rule_y, rule_x + rule_w, rule_y + 2), fill=SAFFRON)
    draw.text(((w - tag_w) // 2, rule_y + 16), SLOGAN, font=tag, fill=IVORY)
    save_rgb(im, OUT / "promo-small-440x280.png")


def promo_marquee():
    w, h = 1400, 560
    im = Image.new("RGB", (w, h), GRAPHITE)
    draw = ImageDraw.Draw(im)
    draw.rectangle((0, 0, w, 4), fill=SAFFRON)
    ghost = Image.new("RGB", (w, h), GRAPHITE)
    gdraw = ImageDraw.Draw(ghost)
    draw_mark(gdraw, 1020, 140, 300, 4)
    ghost = ghost.filter(ImageFilter.GaussianBlur(0.4))
    im = Image.blend(im, ghost, 0.14)
    draw = ImageDraw.Draw(im)

    tag = font("Inter-Medium.ttf", 30)
    support = font("Inter-Regular.ttf", 20)
    chip = font("Inter-Medium.ttf", 15)
    pad_x = 96
    mark = 128
    top = 128

    draw_mark(draw, pad_x, top, mark, 5)
    _, lockup_h, _ = draw_wordmark(draw, pad_x + mark + 28, top + 22, 84, 36)

    slogan_y = top + max(mark, lockup_h + 18) + 36
    draw.text((pad_x, slogan_y), SLOGAN, font=tag, fill=IVORY)
    _, tag_h = measure(draw, SLOGAN, tag)
    draw.text((pad_x, slogan_y + tag_h + 14), SUPPORT, font=support, fill=DUST)

    chips = ["Tab or screen", "Auto zoom", "Nothing uploads"]
    y = 452
    x = pad_x
    for label in chips:
        cw, ch = measure(draw, label, chip)
        box = (x, y, x + cw + 28, y + ch + 18)
        draw.rounded_rectangle(box, radius=999, outline=(58, 55, 48), width=1)
        draw.text((x + 14, y + 8), label, font=chip, fill=DUST)
        x = box[2] + 14
    save_rgb(im, OUT / "promo-marquee-1400x560.png")


def cdp_call(ws, method, params=None, timeout=30):
    import websocket
    req_id = int(time.time() * 1000) % 1000000 + os.getpid() % 99
    ws.send(json.dumps({"id": req_id, "method": method, "params": params or {}}))
    deadline = time.time() + timeout
    while time.time() < deadline:
        msg = json.loads(ws.recv())
        if msg.get("id") == req_id:
            if "error" in msg:
                raise RuntimeError(msg["error"])
            return msg.get("result", {})
    raise TimeoutError(method)


def capture_with_cdp(url: str, dest: Path, timeout: int, width=1280, height=800, fit=True):
    import base64
    import websocket

    port = 9334
    profile = Path("/tmp/zinra-store-chrome-cdp")
    profile.mkdir(parents=True, exist_ok=True)
    chrome = subprocess.Popen([
        "google-chrome",
        "--headless=new",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--remote-allow-origins=*",
        f"--user-data-dir={profile}",
        f"--remote-debugging-port={port}",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-first-run",
        f"--window-size={width},{height}",
        "--force-device-scale-factor=1",
        "about:blank",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        ws_url = None
        for _ in range(50):
            try:
                tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json"))
                ws_url = next(t["webSocketDebuggerUrl"] for t in tabs if t.get("webSocketDebuggerUrl"))
                break
            except Exception:
                time.sleep(0.1)
        if not ws_url:
            raise RuntimeError("DevTools did not start")
        ws = websocket.create_connection(ws_url, timeout=60)
        cdp_call(ws, "Page.enable")
        cdp_call(ws, "Runtime.enable")
        cdp_call(ws, "Emulation.setDeviceMetricsOverride", {
            "width": width, "height": height, "deviceScaleFactor": 1, "mobile": False
        })
        cdp_call(ws, "Page.navigate", {"url": url})
        deadline = time.time() + timeout
        while time.time() < deadline:
            result = cdp_call(ws, "Runtime.evaluate", {
                "expression": "window.__SHOT_READY__ === true",
                "returnByValue": True,
            })
            if result.get("result", {}).get("value") is True:
                break
            time.sleep(0.3)
        else:
            raise TimeoutError(f"ready flag never set for {url}")
        time.sleep(0.25)
        data = cdp_call(ws, "Page.captureScreenshot", {
            "format": "png", "fromSurface": True
        })["data"]
        raw = base64.b64decode(data)
        tmp = dest.with_suffix(".raw.png")
        tmp.write_bytes(raw)
        im = Image.open(tmp).convert("RGB")
        if fit and im.size != (width, height):
            canvas = Image.new("RGB", (width, height), GRAPHITE)
            im.thumbnail((width, height), Image.Resampling.LANCZOS)
            canvas.paste(im, ((width - im.width) // 2, (height - im.height) // 2))
            im = canvas
        save_rgb(im, dest)
        tmp.unlink(missing_ok=True)
        ws.close()
        return im
    finally:
        chrome.terminate()
        try:
            chrome.wait(timeout=4)
        except subprocess.TimeoutExpired:
            chrome.kill()


def trim_graphite(im: Image.Image) -> Image.Image:
    px = im.load()
    w, h = im.size
    top, bottom = 0, h - 1
    for y in range(h):
        if any(px[x, y] != GRAPHITE for x in range(0, w, 4)):
            top = y
            break
    for y in range(h - 1, -1, -1):
        if any(px[x, y] != GRAPHITE for x in range(0, w, 4)):
            bottom = y
            break
    return im.crop((0, top, w, bottom + 1))


def compose_popup_shot(base_url: str):
    card_path = SHOTS / "popup-card-raw.png"
    capture_with_cdp(f"{base_url}/popup-card.html", card_path, 12, width=400, height=780, fit=False)
    card = trim_graphite(Image.open(card_path).convert("RGB"))
    card_path.unlink(missing_ok=True)
    max_h = 700
    if card.height > max_h:
        ratio = max_h / card.height
        card = card.resize((int(card.width * ratio), max_h), Image.Resampling.LANCZOS)

    canvas = Image.new("RGB", (1280, 800), GRAPHITE)
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((0, 0, 1280, 44), fill=GRAPHITE_2)
    draw.ellipse((16, 17, 26, 27), fill=(58, 55, 48))
    draw.ellipse((32, 17, 42, 27), fill=(58, 55, 48))
    draw.ellipse((48, 17, 58, 27), fill=(58, 55, 48))
    draw.rounded_rectangle((70, 10, 250, 34), radius=8, fill=(44, 42, 37))
    draw.text((90, 14), "Northlane  ·  Team", font=font("Inter-SemiBold.ttf", 12), fill=IVORY)
    draw.rounded_rectangle((262, 10, 1188, 34), radius=8, fill=GRAPHITE)
    draw.text((276, 15), "northlane.app/team", font=font("Inter-Regular.ttf", 11), fill=DUST)
    draw.rounded_rectangle((1200, 8, 1264, 36), radius=8, outline=SAFFRON, width=1)
    icon = Image.open(ROOT / "icons" / "icon32.png").convert("RGBA").resize((18, 18), Image.Resampling.LANCZOS)
    canvas.paste(icon, (1223, 13), icon)

    page = Image.open(SHOTS / "backdrop-page.jpg").convert("RGB")
    page = page.resize((1280, 756), Image.Resampling.LANCZOS)
    canvas.paste(page, (0, 44))

    # Soft shadow + card
    x, y = 1280 - card.width - 28, 56
    shadow = Image.new("RGB", (card.width + 24, card.height + 24), (10, 9, 8))
    canvas.paste(shadow, (x - 8, y + 10))
    canvas.paste(card, (x, y))
    save_rgb(canvas, OUT / "screenshot-01-popup-1280x800.png")


def capture_pages(base_url: str):
    print("composing popup", flush=True)
    compose_popup_shot(base_url)
    targets = [
        ("recorder.html", "screenshot-03-recorder-1280x800.png", 12),
        ("editor.html", "screenshot-02-editor-1280x800.png", 40),
        ("editor.html?overlay=export", "screenshot-04-export-1280x800.png", 40),
    ]
    for page, name, timeout in targets:
        print(f"capturing {page}", flush=True)
        capture_with_cdp(f"{base_url}/{page}", OUT / name, timeout)


def main():
    promo_small()
    promo_marquee()
    port = 8766
    server = subprocess.Popen(
        ["python3", "-m", "http.server", str(port)],
        cwd=str(ROOT),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        time.sleep(0.4)
        capture_pages(f"http://127.0.0.1:{port}/store-assets/shots")
    finally:
        server.terminate()
        server.wait(timeout=5)


if __name__ == "__main__":
    main()
