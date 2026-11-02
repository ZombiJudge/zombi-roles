# Design rules

Zombi Roles uses the zombi.dev look. These rules come from `resources/css/zombi-tokens.css` and `zombi-theme.css` in the private `ZombiJudge/zombi-dev` repo. That repo stays read-only, and files are copied from it only when a step needs them.

## Themes

The panel follows the device's light or dark setting.

| Token | Light (Daylight) | Dark (Crypt) | Use |
|---|---|---|---|
| `--surface` | `#f3f1e8` | `#0e120f` | Page background |
| `--surface-raised` | `#ffffff` | `#171d18` | Cards and menus |
| `--surface-sunken` | `#e7e4d7` | `#090c0a` | Wells and table headers |
| `--line` | `#d3cfbf` | `#2b352d` | Dividers |
| `--line-strong` | `#7a7f70` | `#62716a` | Control borders |
| `--ink` | `#151915` | `#ebe7d6` | Main text |
| `--ink-muted` | `#545d53` | `#a3ad9f` | Supporting text |
| `--ichor` | `#3c7a12` | `#9be84a` | Primary action |
| `--ichor-text` | `#336a0e` | `#9be84a` | Primary-colored text |
| `--on-ichor` | `#ffffff` | `#0e120f` | Text on primary |
| `--amber` | `#8a5700` | `#f5b43c` | Warnings |
| `--wound` | `#a33914` | `#ff7a4d` | Errors and destructive actions |
| `--signal` | `#1d64a6` | `#7cc4ff` | Information |
| `--focus-ring` | `#22460a` | `#9be84a` | Keyboard focus ring |
| `--focus-gap` | `#ffffff` | `#0e120f` | Gap inside the focus ring |

The source repo states that every text pair is at least 4.5:1 and every control border, indicator, and focus ring is at least 3:1, in both themes.

## Layout

Computer first. The panel runs on Windows and Mac computers, and is not designed for phones. On a window of 1280 by 720 or larger, screens fit with no page scrolling, and only long lists scroll inside themselves. Very narrow windows and heavy browser zoom stack the layout so nothing is cut off, which the WCAG 2.2 AA zoom rule requires.

## Type

- **JetBrains Mono** is the brand voice: headings, buttons, labels, and data. It ships in weights 500, 700, and 800.
- **Atkinson Hyperlegible Next** is the body font: body text, member names, and inputs. It ships in weights 400 and 700.
- Both are self-hosted and licensed under the SIL Open Font License, so the license text is copied with the fonts.
- Use `rem` sizes so browser zoom works, and tabular figures for numbers people compare.

## Shape and spacing

- Corners: 4px for badges, inputs, and checkboxes; 8px for buttons, cards, and menus; 16px for dialogs.
- Spacing: 4px steps. Tap targets are 48px where possible and never under 24px.
- Surfaces are separated by borders. Only floating layers get a shadow.

## Focus

Every interactive control uses a 2px outline with a 2px offset in `--focus-ring`, plus a 2px ring in `--focus-gap`. It is an outline, so it survives Windows high-contrast mode.

## Logo

Use the simplified hand mark from `resources/views/public/partials/logo-mark.blade.php`, colored with `--ichor`. It is meant for 48px and below. Do not use `public/favicon.svg` from that repo until its artwork is checked, because it does not appear to be the hand mark.

## Writing

Never use the em dash in writing, docs, or UI text. A test enforces this.
