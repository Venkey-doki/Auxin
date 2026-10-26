---
name: Auxin
description: A local microservice manager where every running service is a ticket clipped to a steel rail, its log printing beneath it.
colors:
  bg: "#121416"
  rail: "#0d0f11"
  surface: "#171a1d"
  surface-2: "#1d2124"
  surface-3: "#252a2e"
  pop: "#1b1e21"
  line: "#24282c"
  line-strong: "#32373c"
  rail-bar: "#3a3f44"
  fg: "#e9e7e1"
  fg-2: "#a7abaf"
  fg-3: "#868c92"
  paper: "#efece4"
  paper-hi: "#fffdf6"
  paper-2: "#e4e0d6"
  paper-line: "#c9c4b8"
  ink: "#1c1d1f"
  ink-2: "#5c5b56"
  ok: "#3fb950"
  ok-ink: "#1d7a33"
  warm: "#f0a43a"
  warm-ink: "#8a5208"
  bad: "#ef5350"
  bad-soft: "#ff8a87"
  bad-ink: "#c0282a"
  idle: "#6b7277"
  idle-ink: "#5f5c55"
typography:
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Segoe UI, Roboto, Helvetica Neue, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Segoe UI, Roboto, Helvetica Neue, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 600
    lineHeight: 1.45
    letterSpacing: "-0.025em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Segoe UI, Roboto, Helvetica Neue, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.45
  body-sm:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Segoe UI, Roboto, Helvetica Neue, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.45
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Segoe UI, Roboto, Helvetica Neue, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 600
    lineHeight: 1.45
    letterSpacing: "0.05em"
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: "18px"
  stamp:
    fontFamily: "JetBrains Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "0.6875rem"
    fontWeight: 600
    lineHeight: "18px"
    letterSpacing: "0.08em"
rounded:
  stamp: "3px"
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  full: "9999px"
spacing:
  "1": "4px"
  "1.5": "6px"
  "2": "8px"
  "2.5": "10px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
components:
  button-default:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.fg}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "28px"
  button-default-hover:
    backgroundColor: "{colors.surface-3}"
  button-primary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "28px"
  button-primary-hover:
    backgroundColor: "{colors.paper-hi}"
  button-danger:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.bad-soft}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "28px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.fg-2}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "28px"
  button-ghost-hover:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.fg}"
  button-sm:
    padding: "0 8px"
    height: "24px"
  ticket-button-go:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.sm}"
    padding: "0 8px"
    height: "24px"
  input:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.fg}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "32px"
  ticket-header:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    padding: "12px 12px 10px"
  ticket-header-lg:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    padding: "20px 24px 16px"
  stamp:
    textColor: "{colors.ok-ink}"
    typography: "{typography.stamp}"
    rounded: "{rounded.stamp}"
    padding: "0 6px"
  sidebar-row:
    textColor: "{colors.fg-2}"
    rounded: "{rounded.md}"
    padding: "4px 4px 4px 8px"
    height: "30px"
  sidebar-row-active:
    backgroundColor: "{colors.surface-3}"
    textColor: "{colors.fg}"
  menu-item:
    textColor: "{colors.fg}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "4px 8px"
    height: "30px"
  popover:
    backgroundColor: "{colors.pop}"
    rounded: "{rounded.lg}"
    padding: "4px"
  segmented:
    backgroundColor: "{colors.rail}"
    rounded: "{rounded.md}"
    padding: "2px"
  segmented-active:
    backgroundColor: "{colors.surface-3}"
    textColor: "{colors.fg}"
    rounded: "{rounded.sm}"
    height: "22px"
---

# Design System: Auxin

## Overview

**Creative North Star: "The Pass"**

Auxin is a kitchen expo pass for local services. Every service is a thermal-paper ticket clipped to a steel rail; its log prints downward beneath it like a receipt. The shell is brushed steel, dark and quiet, so the paper tickets and their stamped state marks are the brightest things on screen. A developer glances across the rail and reads the state of the whole stack the way an expediter reads the pass.

The system is dense and desktop-native. Body text is 13px system sans, rows are 30px, controls are 24 to 28px tall, and one mono face (JetBrains Mono) is reserved for machine output: logs, ports, PIDs, indexes, paths, commands, and the stamps. Structure comes from single hairlines and tonal steps of steel, never from stacked cards. Depth exists only where something floats.

Two materials carry meaning. Steel is the room; paper is the thing being worked on. Anything printed on paper switches to the ink palette and the darker state twins, and takes an ink focus ring.

**Key Characteristics:**
- Brushed-steel dark shell in five tonal steps, divided by single 1px hairlines.
- Thermal-paper ticket headers in warm off-white with near-black ink.
- Stamped uppercase state marks in mono, outlined in their own ink.
- Status carried by shape as well as hue: solid, dashed ring, struck ring, hollow ring.
- A stable identity colour per service, always shown as a 3px rounded bar.
- A stable two-digit index per service, set in mono.
- Shadows only on floating layers.

## Colors

A cool, nearly neutral steel ramp for the shell, a warm paper-and-ink pair for tickets, and four state hues that each have a darker twin for printing on paper.

### Primary
- **Thermal Paper** (paper): the ticket header ground, the primary button, the checked checkbox, and the "new lines" pill. Paper is the system's accent; it marks the thing you act on.
- **Bright Paper** (paper-hi): hover state of paper buttons only.
- **Ticket Ink** (ink): all text on paper, the ticket's Start button fill, and the focus ring on paper surfaces.
- **Faded Ink** (ink-2): secondary text on paper: the index, framework, uptime, PID, inactive ticket buttons.
- **Paper Shade** (paper-2) and **Paper Crease** (paper-line): the command chip inside a large ticket, and hover washes and link underlines on paper.

### Secondary
- **Pass Green** (ok) / **Stamped Green** (ok-ink): running. The hue on steel, the twin on paper and on the enabled switch track.
- **Heat-Lamp Amber** (warm) / **Stamped Amber** (warm-ink): starting, waiting, stopping, and anything that needs the user's attention.
- **Ticket Red** (bad), **Soft Red** (bad-soft), **Stamped Red** (bad-ink): crashed and destructive. bad-soft is the readable red for text and danger buttons on steel; bad at 7 to 15% alpha washes error log lines and destructive hovers.
- **Steel Grey** (idle) / **Stamped Grey** (idle-ink): stopped, exited, queued.

### Neutral
- **Rail Black** (rail): the sidebar, the board lanes behind logs, inputs, and segmented-control tracks.
- **Steel Ground** (bg): the window background.
- **Steel Surface** (surface), **Raised Steel** (surface-2), **Lit Steel** (surface-3): pane backgrounds, default buttons, then hover and selected rows.
- **Popover Steel** (pop): menus, the command palette, and toasts.
- **Hairline** (line) and **Strong Hairline** (line-strong): dividers and control borders. Lanes are separated by a 1px gap showing hairline behind them.
- **Rail Bar** (rail-bar): the flat 2px bar each ticket hangs from.
- **Chalk** (fg), **Dim Chalk** (fg-2), **Muted Chalk** (fg-3): primary text, secondary text, labels and placeholders. fg-3 is the darkest text allowed on steel.

### Named Rules
**The Twin Rule.** Every state hue has a darker ink twin. Use the hue on steel and the twin on paper; a bright hue printed on paper is illegible.

**The Amber Is Attention Rule.** Heat-lamp amber means "in progress" or "look at this": starting and waiting states, a pending-restart banner, a missing command. It is never a focus colour, a selection colour, or a decorative accent.

**The Paper Is the Accent Rule.** The only non-state accent is paper. Primary actions are paper buttons with ink text; there is no blue.

## Typography

**Body Font:** system sans (-apple-system, SF Pro Text, Segoe UI, Roboto)
**Label/Mono Font:** JetBrains Mono (with ui-monospace, SF Mono, Menlo)

**Character:** The native system face keeps Auxin feeling like a well-made Mac tool beside the editor. JetBrains Mono is the voice of the machine. Where text came from a process or identifies one (logs, ports, PIDs, paths, commands, indexes, stamps), it is mono. Everything a person wrote, such as names, labels and buttons, is sans.

### Hierarchy
- **Headline** (700, 22px, tight tracking): the service name on a large ticket and the empty-state ticket title. Semibold at the same size titles first-run screens.
- **Title** (600, 15px, tight tracking): the view title in the top bar. Empty-state titles step up to 18px semibold.
- **Body** (400, 13px, 1.45): default UI text, menu items, inputs, and ticket names (in bold).
- **Body Small** (500, 12px): buttons, hints, field labels, secondary metadata.
- **Label** (600, 11px, 0.05em tracking, uppercase, fg-3): section heads in the sidebar (Flows, Groups, Services) and pane headers (Start order, Logs). It labels a region; it never sits above a headline.
- **Mono** (400, 12px, 18px fixed line): log lines, at 11px for ticket metadata and sidebar last-log lines. Numerals are tabular.
- **Stamp** (600 mono, 11px, 0.08em tracking, uppercase): state marks on tickets, 12px on a large ticket.

### Named Rules
**The Machine Speaks Mono Rule.** Mono is for what the machine printed or uses as an identifier. Never set UI prose or headings in mono.

**The Small Scale Rule.** The ramp runs from 11px to 22px. Nothing in the app is display-sized; hierarchy comes from weight and material, not size.

## Layout

A two-column desktop grid: a fixed 272px sidebar on rail black, then the main view. Every main view starts with a 52px top bar that doubles as the window drag region, divided from the content by one hairline. Pane headers below it are 44px.

The board is the core layout. Lanes are at least 320px wide and sit in a horizontal row, scrolling sideways when they overflow. Each lane stacks the 2px rail bar, the paper ticket, then the log filling the rest of the height. Lanes are separated by a 1px gap that shows the hairline colour behind them. The grid layout uses two columns with rows of at least 320px. When lanes overflow the window, an index strip of every ticket's state appears above the rail, so a crash in an off-screen lane is still visible.

Spacing is on a 4px base. 4, 6, 8 and 12px do most of the work inside rows and controls; 16, 20 and 24px pad panes and large tickets. Settings content is capped at 720px and empty states at 460 to 560px.

## Elevation & Depth

Flat by default. Depth on the shell comes from tonal steps of steel (rail, ground, surface, surface-2, surface-3) and single hairlines, not shadows. The paper tickets read as raised because of their material and brightness, not because of a shadow.

### Shadow Vocabulary
- **Popover** (`box-shadow: 0 12px 32px rgb(0 0 0 / 0.5), 0 2px 6px rgb(0 0 0 / 0.3)`): menus and pickers.
- **Toast** (`box-shadow: 0 10px 28px rgb(0 0 0 / 0.45)`): bottom-right notifications.
- **Palette** (`box-shadow: 0 24px 64px rgb(0 0 0 / 0.6)`): the command palette.
- **Floating pill** (`box-shadow: 0 6px 18px rgb(0 0 0 / 0.45)`): the "new lines / Latest" jump pill over a log.

### Named Rules
**The Only Floaters Cast Shadows Rule.** A shadow means the element floats above the window: popovers, the palette, toasts, the log jump pill. Panes, tickets, rows and cards never cast one.

**The Single Hairline Rule.** Regions are divided by one 1px hairline. Never double a border by nesting bordered cards.

## Shapes

Small, tight corners: 3px on stamps and checkboxes, 4px on icon buttons, menu items and ticket buttons, 6px on buttons, inputs, rows and step cards, 8px on popovers and toasts, 12px on the command palette. Fully round shapes are reserved for status marks, the switch, the flow step number, the identity bar, and the log jump pill. Ticket headers are square-edged; they hang flush from the rail bar.

The stamp is the signature form: a 1.5px outline in the stamp's own colour (currentColor) around an uppercase mono label, upright, with a status mark leading.

## Components

### Buttons
Compact and quiet; the paper button is the only loud one.
- **Shape:** gently rounded (6px), 1px border, 28px tall (24px small), 10px horizontal padding (8px small), 14px icons with a 6px gap.
- **Primary:** paper fill, ink text, semibold. Used for the one main action of a view (Run flow, Open folder, Restart).
- **Default:** raised steel fill, strong hairline border, chalk text; hover lifts to lit steel.
- **Danger:** raised steel with soft-red text; hover adds a red border at 40% and a red wash at 10%.
- **Ghost:** transparent, dim chalk text; hover fills raised steel.
- **Press / Disabled:** pressing nudges the button down 1px; disabled drops to 45% opacity.
- **Focus:** a 2px paper outline at 1px offset (ink on paper surfaces).

### Icon Buttons
- **Shape:** 26px square (22px small), 4px radius, 15px icons (13px small), dim chalk.
- **Hover:** lit steel fill, chalk icon. Toggle buttons expose `aria-pressed` and sit on lit steel when on.

### Ticket Buttons
- **Style:** printed on paper. Inactive buttons are faded ink and get a paper-crease wash on hover. The Start button is an ink fill with paper text, 24px tall with a 4px radius, and goes black on hover.

### Inputs / Fields
- **Style:** rail-black fill, strong hairline border, 6px radius, 32px tall, 13px text, fg-3 placeholder.
- **Focus:** the border turns paper at 70% and the fill darkens; no outer ring.
- **Fields:** a 12px semibold fg-2 label above the input, with an optional 12px fg-3 hint below it, 6px apart.

### Segmented Control
- **Style:** a rail-black track with a hairline border, 6px radius and 2px padding. Segments are 22px tall. The active segment is lit steel with an inset 1px strong-hairline ring; inactive segments are fg-3 text.

### Navigation (Sidebar)
- **Style:** rail-black column on the left, holding the workspace switcher, a "Jump to…" field with a shortcut key cap, then the Flows, Groups and Services sections under uppercase labels.
- **Rows:** 30px minimum, 6px radius, dim chalk text. Hover fills raised steel; the active row is lit steel with chalk text.
- **Service rows:** a status mark, the 3px identity bar, the name, and the last log line in 11px mono beneath it (soft red when crashed). A row action (start or stop) sits at the right. A start action hovers to paper with ink; a stop action hovers to a red wash.
- **Footer:** when anything is live, a running count with a green dot and a small danger "Stop all".

### Menus and Popovers
- **Style:** popover steel, strong hairline border, 8px radius, 4px padding, popover shadow, entering with a 150ms drop-in. Items are 30px with a 4px radius and turn lit steel on hover or when active. Separators are a single hairline. Group labels use the uppercase Label style.

### Ticket (Signature Component)
The service's name plate, clipped to the rail.
- **Structure:** a 2px rail bar above a square-edged paper header. On the left are the identity bar, the two-digit mono index, the bold name, and a mono metadata row (underlined port link, framework, uptime, PID, exit code). On the right are the stamp and the ticket buttons.
- **Sizes:** small on the board (12px padding, 13px name); large on the service page (20 and 24px padding, 22px headline name, plus the command shown as a paper-shade chip).
- **Stamp:** an outlined uppercase mono state mark in the ink twin of its state colour. It plays a 280ms press-in (from 1.35x scale and transparent to flat) only when the state actually changes, never on mount. Reduced motion collapses it to an instant change.
- **Log beneath:** 12px mono on rail black with an 18px line. Error lines get a 7% red wash, system lines are italic fg-3, and search hits are marked with 30% amber.

### Status Mark
Status is carried by shape as well as hue. Running is a solid dot; starting, waiting and stopping are a dashed ring that spins slowly (2.4s); crashed is a ring struck through; stopped and exited are a hollow ring; queued is a fine dotted ring. On steel it uses the state hue; inside a stamp it uses the stamp's ink.

### Identity Bar
Each service has a stable colour from a fixed set of ten. It is always shown as a 3px-wide, fully rounded vertical bar beside the name: in sidebar rows, on tickets, in flow steps, in the service picker and in the merged-log legend. In a merged log the service's tag text takes the same colour.

### Flow Step
A numbered list joined by a 1px strong-hairline order line. Each step has a 24px round number in its state colour, and a step card with a 6px radius, a hairline border, and a small paper header (identity bar, bold name, move and remove controls), with the wait condition and step state below on steel.

## Do's and Don'ts

### Do:
- **Do** put a service's state on paper as an outlined uppercase mono stamp in the state's ink twin (ok-ink, warm-ink, bad-ink, idle-ink).
- **Do** pair every status hue with its StatusMark shape so state reads without colour.
- **Do** show service identity as the 3px fully rounded identity bar, and the index as a two-digit mono number.
- **Do** hang every ticket from a flat 2px rail-bar (#3a3f44) and divide lanes with a 1px hairline gap.
- **Do** wrap paper surfaces in `.on-paper` so focus rings turn ink; on steel the focus ring is a 2px paper outline.
- **Do** keep amber for in-progress states and things that need attention.
- **Do** animate a stamp only when its state changes, and keep the reduced-motion guard.

### Don't:
- **Don't** use amber for focus, selection, toggled controls or decoration.
- **Don't** cast shadows from panes, tickets, rows or cards; shadows belong only to popovers, the palette, toasts and the log jump pill.
- **Don't** stack bordered cards inside bordered panes; one hairline divides one region.
- **Don't** set UI prose, names or headings in mono; mono is for machine output and identifiers.
- **Don't** print bright state hues on paper or ink twins on steel.
- **Don't** tilt the stamp or add gradient clips or perforation edges to tickets; the finish review removed all three, and the ticket is now a flat paper header on a flat rail.
- **Don't** introduce text darker than fg-3 (#868c92) on steel.
