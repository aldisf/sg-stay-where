---
version: "1.0"
name: sg-stay-where
description: Calm, map-first Singapore home search.
colors:
  canvas: "#f6f6f3"
  surface: "#ffffff"
  surface-secondary: "#f1f1ed"
  ink: "#1c1c1f"
  ink-secondary: "#47474d"
  muted: "#74747a"
  line: "#e6e5e0"
  line-strong: "#d3d2cc"
  primary: "#0f766e"
  overlay: "rgba(15, 15, 18, 0.35)"
spacing:
  sm: 8px
  md: 12px
rounded:
  card: 14px
  input: 9px
  pill: 999px
components:
  canvas:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
  secondary-surface:
    backgroundColor: "{colors.surface-secondary}"
    textColor: "{colors.ink-secondary}"
  muted-label:
    textColor: "{colors.muted}"
  divider:
    backgroundColor: "{colors.line}"
  strong-divider:
    backgroundColor: "{colors.line-strong}"
  primary-action:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
  backdrop:
    backgroundColor: "{colors.overlay}"
  touch-control:
    height: 44px
omitted:
  - section: typography
    reason: Fluid typography is documented below with its CSS mapping.
---

# DESIGN.md

Calm, map-first tool for a long, emotional task (finding a home). The map is the
context; the right panel is where decisions happen. One accent, quiet surfaces,
data in tabular numerals, icons that carry meaning.

## Overview

- **Primary task**: decide on new listings (Review) and follow up on the ones you
  chose (Watching, Enquiries).
- **Anchor**: the listing card (photo, price, then the criteria chips).
- **References**: Airbnb's map + list split (density, pill price markers), Linear
  and Things for calm neutral surfaces, Tinder-style swipe for the review deck, and
  iOS Mail-style swipe-to-remove for list rows.

## Colors

| Role | Light | Dark |
| --- | --- | --- |
| canvas | `#f6f6f3` | `#111113` |
| surface / surface-2 | `#ffffff` / `#f1f1ed` | `#18181b` / `#222226` |
| ink / ink-2 / muted | `#1c1c1f` / `#47474d` / `#74747a` | `#ededee` / `#c4c4c8` / `#9a9aa2` |
| line / line-strong | `#e6e5e0` / `#d3d2cc` | `#2b2b30` / `#3a3a40` |
| accent (action, watch, met-all) | `#0f766e` | `#2dd4bf` |
| miss (unmet must-have) | `#b45309` on `#fcf2e6` | `#f59e0b` on `#33260f` |
| nope (not interested) | `#d93a3a` | `#f87171` |

Theme: follows the system; the header toggle sets `data-theme` on `<html>`
(auto → light → dark, per browser). The Simple map switches between OpenFreeMap
`positron` and `dark`. The Detailed map is OpenFreeMap `liberty` in both themes
(it has no dark variant).

## Typography

Type: Inter (Google Fonts) with system fallbacks; root size
`clamp(15px, 12.5px + 0.25vw, 18px)`. Roles: section labels 0.78rem uppercase
+0.07em; card name 0.98rem/600; price 1.12rem/700 (1.6rem in the deck and sheet),
tabular numerals for every number.

## Layout

The map and panel each establish their own stacking context. Map markers and
controls cannot appear above navigation, cards or dialogs. Clip map contents to
its bounds. MapLibre owns marker `transform`; use the independent `scale`
property for pin emphasis.

The primary color maps to `--accent`. The spacing tokens map to `--space-sm` and `--space-md`. Touch controls use
`--touch-target` at 44px on phones. The overlay token maps to `--overlay`.

## Elevation & Depth

Shadows are limited to floating elements: cards being swiped, sheets, menus and toasts.

## Shapes

Radius 14px (cards), 9px (inputs), pills 999px. Shadows only for floating things
(deck card, sheet, menus, toast).

## Components

- **Criteria chips**: one per project criterion (Lucide icon + short value).
  `ok` ink on surface-2; `miss` amber dashed; `unknown` faint dashed "?"; `plain`
  (scored, not a must-have) outlined. Labelled grid (3 columns, 2 on phones) in the
  deck and sheet; must-haves only in the Watching list.
- **Score tag**: ink square with the score; accent when every must-have is met.
- **Review deck**: one card on top, the next peeking under it; drag shows a
  WATCH / NOT INTERESTED stamp with the drag distance; buttons and ←/→ do the same.
  Toast with Undo for every decision.
- **Watching row**: photo, price, status pill (Watching, Contacted, Agent replied,
  Viewing set…), name, must-have chips, lead line. The row shows where the home
  stands, never an action button. Removing is a two-stage swipe left (touch or
  mouse drag): the card slides over a red zone (`#c53030`, white trash icon); past
  75% of the row's width, or a fast fling past 40%, the label "Not interested"
  appears and letting go marks it Not interested (rejected, repeats hidden, Undo in
  the toast). Releasing earlier springs back and saves nothing. Right drags and
  rows already Not interested only give a little. On desktop the detail sheet's
  Not interested button is the non-gesture path.
- **Map pins**: white pills "score $price"; focused/top card accent-filled; viewing
  booked ink-filled; commute places as cream labels with their icon; amenities of
  the open listing as small accent circles.
- **Map detail switch**: a MapLibre control above the zoom buttons, building icon
  + "Detailed", accent-filled when on (`aria-pressed`). Simple (positron/dark)
  keeps pins readable; Detailed (liberty) adds building footprints, POIs, road
  names and HDB block numbers (an added `housenumber` symbol layer from the
  OpenMapTiles source, zoom 17+, muted text with a white halo). Remembered per
  browser. It never switches by itself: a style swap re-downloads tiles and
  flashes the map, so opening a listing keeps the viewer's choice. All pins are
  DOM markers and survive the swap; style-dependent layers are re-added on
  `style.load`. OneMap was rejected (its terms require developer registration for
  web apps) and satellite imagery for licensing.
- **Search cards**: title, site tag, last poll, switch (accent when on).
- **Detail sheet**: native modal dialog, right sheet (full screen on phones), carousel + nested lightbox,
  actions row, criteria grid, score breakdown, one Latest block, chat thread. Focus stays in the
  open dialog; Escape and browser Back close it and restore focus to the opener.
- **Filters**: name, area or agent search, existing criteria switches and sort.
  Collapsed behind "Filter & sort" on phones; expanded on desktop. Always show
  one result line beside them ("6 shown", "2 of 6 to review") and Reset filters
  (back to the defaults) when filters differ from them. Chips stay label-only:
  per-chip counts wrapped the chip row onto two lines at 390px, and a number on an
  active chip reads as "matches" rather than "if toggled". The Review tab badge and
  the header's "N to review" count what the deck will show with the current search
  and filters. Empty states distinguish a filtered result (with how many are
  waiting behind the filters) from an empty watch list or unfinished checks.
- **Poll status**: failed runs use the existing amber poll button treatment. Show
  "Last poll failed", keep retry available, and put the reason in its tooltip.
- **Connection status**: failed refreshes keep loaded listings visible and offer
  Retry. A failed initial load preserves the app shell.


## Responsive

Desktop: map | panel (`clamp(460px, 38vw, 660px)`). ≤ 860px: map on top (40svh;
24svh in Review, 22svh on Searches/Project), panel below, sticky deck buttons,
header wraps the add field to its own row, the WhatsApp label collapses to a dot.
The project title truncates before crowding the header controls. The decision
bar respects the phone's bottom safe area. Native dialogs cover the viewport.

Card gestures use `touch-action: pan-y pinch-zoom` and root horizontal overscroll
containment. Cancel browser handling only after a horizontal touch is identified.
Vertical scrolling, pinch zoom, cancelled gestures and short drags do not decide
a listing. Lost capture from a photo must not cancel capture transferred to its
card. The buttons remain an alternative to swiping.

## Motion

Deck card enters with a 0.22s scale-in; fly-off 0.24s; sheet slides 0.2s; a
released list row springs back in 0.2s, or slides off in 0.18s and its gap closes
in 0.18s; everything off under `prefers-reduced-motion` (a removed row goes at once).

## Icons

Lucide (ISC), vendored in `public/icons/`, drawn through CSS masks (`.ic` with
`--icon`) so they take the text colour. `washing-machine.svg` is drawn in Lucide's
style for this project.

## Do's and Don'ts

- Keep MapLibre's positioning classes and transforms when updating markers.
- Reuse unchanged markers and markup; render a tab when it becomes visible.
- Preserve visible focus and accessible names on icon buttons and listing links.
- Do not claim iPhone system-edge gestures are covered by desktop WebKit tests.

Interaction references: [WAI modal dialogs](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/),
[WebKit history-navigation behavior](https://bugs.webkit.org/show_bug.cgi?id=240183).

## Enquiries and sourcing briefs

Enquiries has one row per home the user is in touch about (a property chat, a
sent intro, a viewing or an interpreted update), never one row per event. A row
shows thumbnail, price, status pill, name, agent, the viewing time (accent when
upcoming), one latest-activity line with its relative time, and "New" with a
single accent edge when it has unread updates. "New" carries no number: a home has
one latest state, so counting superseded readings would repeat the noise the sheet
removes. Sections, in order: Needs your
attention (unread), Upcoming viewings (soonest first), In progress, Ended
(collapsed `<details>`, visible Watch again), then Chats not matched to a
listing. The detail sheet holds the home's latest state and chat; opening it
marks that home's updates read.

The Latest block is the only place the sheet shows interpreted updates. It holds
the newest reading of the chat (text, Next, when it was read), headed by the
outcome that reading recorded (Enquiry declined, Viewing cancelled…) or else the
decision, the viewing time when set, and the agent's reply if one arrived after
the reading. Older readings are superseded, never listed. "New" and an accent
edge mark it while the home has unread updates. After a manual status choice
(Watch again) the outcome headline is dropped; the reading's text stays. The tab badge counts homes, not events. Map
pins are the rows outside Ended, labelled with the viewing time where set; the
phone map is 24svh. A cancelled appointment leaves Upcoming viewings; do not
reintroduce it from historical chat hints.

The contact dialog always offers Copy message. It is the primary action when
WhatsApp is not linked and the way out when the agent has no number; copying
watches the listing and sends nothing.

The Searches tab starts with an ordinary-language brief. Show pending, applied,
or needs-detail feedback beside it. Portal filters remain inspectable below.
Never show model/provider configuration in this flow.

Toast label and property name share a baseline; truncate only the name and keep
Undo reachable at 320px. Committed gestures may request a short vibration, with
visual confirmation on browsers without the Vibration API. Do not use hidden
checkbox hacks to claim iPhone haptic support.
