---
version: 1
slug: "src-app-tsx"
primary_target: "src/App.tsx"
related_targets: []
---

Scope: the whole Auxin desktop app shell (sidebar, service view, group board, flow view, palette). Mode: Operate.

Audience/job: developers running 5–10 local services for end-to-end testing; start the stack in one action, diagnose it in one view. Used for hours beside a dark editor on a laptop.

## Direction contract

THESIS: Every running service is a ticket clipped to the rail; its log prints downward beneath it like a receipt. Refuses the category default of a grey table with a tabbed log drawer.

OWN-WORLD: Brushed-steel dark shell (#121416 ground, #0e1012 rail), thermal-paper ticket headers (#efece4 paper, #1c1d1f ink), stamped uppercase state marks, a thin steel rail bar the tickets hang from, one mono face (JetBrains Mono) for machine output only, system sans for UI. Status green #3fb950 / heat-lamp amber #f0a43a / red #ef5350 / steel grey. Single hairline dividers, no stacked cards, no shadows except popovers. Raises: stable identity colour + name plate with last log line per service (Character Catalog); stable two-digit index doubling as ⌘1–9 shortcut (Factory Catalog); status by shape as well as hue (Emission Rail); single-hairline discipline (Centre Rail).

STORY: The developer opens a folder, sees every service already detected, runs a flow, and watches each ticket's stamp turn RUNNING while logs print beneath; a crash stamps red and is visible from anywhere.

FIRST VIEWPORT: Left sidebar (workspace switcher, Flows with run buttons, Groups, Services with status marks and last log line, Stop-all footer). Main area: the rail board — a row of paper ticket headers (index, name, port link, uptime, stamp, start/stop) each with its log column below. Primary action: Run flow / Start on the ticket.

FORM: The Pass (kitchen expo ticket rail), position 5 on the ordered list; seed key 5167a0d4.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

Unresolved: light theme deferred; Windows/Linux process handling untested.
