# Zinra brand book

Quick spec for logos, icons, and store assets. Zinra is an invented name: a page recorder that punches in on clicks.

**Voice:** film lab, not SaaS neon. Warm, quiet, precise.
**One-liner:** Record a page. Render the zoom.
**Kicker:** Studio
**Do not use:** teal/mint HUD, magnifying-glass marks, Cursor orange `#f54e00`, cream canvases, the word “cursorful.”

---

## Logo construction

The mark is **two rounded rectangles**. The back frame sits up-left. The front frame sits down-right and slightly larger in presence — a punch-in, not a search icon.

```
viewBox 0 0 32 32
stroke 2, round joins, no fill
back:  x=3.5  y=5.5  20×15  rx=3.5
front: x=8.5  y=11.5 20×15  rx=3.5
```

Clear space: one frame-width around the mark. Never add a pointer, spark, or lens.

**Lockup:** mark left, word **Zinra** right, kicker **STUDIO** under the name in 9–10px tracking 0.16em.

**Wordmark:** “Zinra” only. Title case. Never ZINRA in logos (all-caps is fine for tiny UI kickers only).

---

## Color

| Token | Hex | Use |
| --- | --- | --- |
| Graphite | `#1a1916` | App background, dark logo field |
| Graphite 2 | `#23211d` | Panels |
| Graphite 3 | `#2c2a25` | Inputs, lanes |
| Ivory | `#f3efe6` | Primary type, light logo field |
| Dust | `#9a9386` | Secondary type |
| Saffron | `#e0b44a` | Brand, mark stroke, playhead, primary accent |
| Steel | `#5b7c99` | Zoom clips only |
| Leaf | `#6a8f62` | Speed clips only |
| Clay | `#c45c4a` | Record, delete, selected zoom |

**Logo colorways**

1. **Primary (dark):** saffron mark + ivory word on graphite `#1a1916`
2. **Inverse (light):** graphite mark + graphite word on ivory `#f3efe6`
3. **Mark only:** saffron on graphite, or graphite on ivory
4. Never saffron on clay. Never steel/leaf in the logo.

---

## Type

- **UI / wordmark:** Inter or Segoe UI, weight 700, tracking −0.03em
- **Kicker:** same family, 650, 9px, uppercase, tracking 0.16em, Dust
- **Timecode:** Cascadia Mono / JetBrains Mono, saffron

---

## Chrome extension icon

1024² master, graphite field, saffron nested frames centered, ~70% of the canvas, 12–14% padding. Export 128 / 48 / 32 / 16. At 16px, thicken the stroke so both frames still read.

---

## Image-gen prompt (copy)

```
Minimal app logo, two rounded rectangle outlines nested and offset
down-right like a video punch-in / crop, no magnifying glass, no cursor.
Dark warm graphite background #1a1916, saffron gold stroke #e0b44a,
flat vector, even stroke weight, no gradients, no glow, no text.
Centered, generous padding, square app icon.
```

Lockup: same, plus the word “Zinra” in ivory, geometric sans, bold, tight tracking, small “STUDIO” in muted taupe under the name, horizontal layout.
