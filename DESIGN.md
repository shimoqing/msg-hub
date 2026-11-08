# DESIGN.md — msg-hub UI contract

This file is the visual contract for the Web UI (`public/`). Every UI change
must follow it. If a proposed change conflicts with this file, the contract
wins unless the owner changes this file first.

Scope: `public/index.html`, `public/style.css`, `public/app.js`. Server,
protocol and CLI are out of scope.

## Surface

Operate mode: a calm, dense chat workspace opened many times a day. The person
completes a task; expression belongs in precise details, never in decoration.
No marketing-page gestures inside the app.

## Visual direction — paper & ink workbench

Warm paper surfaces, ink text, one coral accent, quiet rounded geometry. The
interface should read as a well-printed desk tool, not a SaaS template: no
gradient identity objects, no glass panels, no neon, no purple.

The single bold gesture is the coral brand mark and the rhythm of the 820px
message column. Everything else stays quiet.

## Color

Source of truth: `:root` in `public/style.css`. Components reference variables
only. Do not add raw hex values outside `:root`; derive borders and shadows
from ink with `rgba()`.

| Token | Value | Role |
|---|---|---|
| `--bg` | `#f7f6f3` | app background |
| `--surface` | `#ffffff` | cards, composer, overlays |
| `--sidebar` | `#f2f1ed` | sidebar paper |
| `--text` | `#1d1b18` | primary ink |
| `--muted` | `#6f6b64` | secondary text (≥5:1 on surface/bg) |
| `--border` / `--border-strong` | ink @ 8% / 14% | hairlines |
| `--accent` | `#e86a4a` | brand, send/action fills |
| `--accent-deep` | `#b04a31` | the only accent used for text on light surfaces |
| `--accent-soft` | `#fcefe9` | accent-tinted surfaces |
| `--success` | `#3e8e6a` | status fills, dots, borders |
| `--success-ink` | `#2f7255` | success text |
| `--warn` | `#c58a2e` | warning fill/accent |
| `--warn-ink` | `#8a5a12` | warning text |
| `--danger` | `#c24b3a` | destructive text/fills |
| `--avatar-1…6-bg` / `-ink` | 6 paper tints | flat identity colors |

Rules:

- Accent never fills a full panel; `--accent-soft` is the largest accent area.
- Text on a tinted surface uses the matching `-ink` token. Body text ≥4.5:1,
  large text ≥3:1. A fill token (`--success`, `--warn`, `--accent`) is never
  used as text on a light surface.
- Identity colors are flat tints only. No `linear-gradient` on avatars, name
  chips, or status objects.
- Status color never carries meaning alone; pair it with a label.
- Light theme only. Dark mode is out of scope until it is explicitly scoped;
  do not half-implement it.

## Type

- UI: `--sans` system stack. No webfonts (zero-dependency constraint).
- Metadata, ids, counts, timestamps: `--mono`.
- Scale: 11 / 12 / 12.5 / 13 / 14 / 16 / 20 px. Functional text never below
  11px; body copy 14px; message body 14px / 1.65. Do not invent sizes outside
  the ramp.
- Weights: 400 / 500 / 600 / 650 / 700 only.
- No all-caps labels, no letter-spaced eyebrows, no decorative em dashes.

## Shape, space, elevation

- Radius roles: 20 panel, 16 bubble, 14 profile card, 12 file chip, 8–9 small
  chip, 6 inline action, pill for tags/buttons. Avatars are circles. Never
  introduce a new radius value without a role.
- Spacing follows a 4px rhythm; optical adjustments of 1–3px are allowed for
  hairlines and icon alignment.
- Message column 820px; sidebar 256px expanded / 64px rail; header 60px.
- Shadow: `--shadow-float` only for layers that float above content (jump
  button, menus, modals, drawer). Inline cards use 1px borders, not shadows.

## Motion

- 120–200ms with `--ease`. Animate state change (expand, reveal, hover), never
  decoration.
- `prefers-reduced-motion` kills transitions; state must remain legible
  without motion.
- The typing dots may loop only while typing is genuinely active.

## Components

- Sidebar: rooms + people, presence dots, unread counts. Collapsed rail keeps
  avatars only; every icon-only control keeps an `aria-label`.
- Messages: 820px column, hanging avatars, 5-minute grouping, day dividers.
- Quote / reply strips: background tint + 1px full border. No thick accent bar
  on one side.
- File cards: type chip, name, size, sha256. No decorative icon set.
- Composer: floating card, one coral send button, removable file chips.
- Overlays: `--surface`, 1px border, `--shadow-float`.

## Banned patterns (detector-checked)

- Side-tab accent borders (thick colored border on one side of a card).
- Gradient avatars or gradient identity objects; purple/blue gradients.
- The same rounded card repeated for every section.
- Glow, glassmorphism, neon, decorative blur.
- ALL-CAPS eyebrows; `A · B · C` meta strings; `→` appended to buttons.
- Emoji as UI icons (inline SVG, 1.5–1.8 stroke, round caps).
- Functional text below 11px; body text below 12px.
- Raw hex outside `:root`; hard-coded font stacks.

## Accessibility floor

- WCAG 2.2 AA: 4.5:1 text, 3:1 large text and graphics, 24×24 minimum pointer
  targets (44×44 preferred on touch), visible focus, labels for icon-only
  controls, `aria-expanded` / `aria-current` where state changes.
- No keyboard traps. Escape closes transient layers.
- Reduced motion honored.

## Checklist for a UI change

1. Uses tokens only; no new hex outside `:root`.
2. Text passes 4.5:1 on its real surface; status text uses `-ink` tokens.
3. No banned pattern from the list above.
4. Checked at 1440×900, 1024×768, 390×844 and with keyboard only.
5. `node --test test/*.test.js` and `node bench/ui-bench.js --check` pass.
6. Run `impeccable detect public/` when the engine is available.
