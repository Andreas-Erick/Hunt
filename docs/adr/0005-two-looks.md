# ADR-0005: Two looks on one set of colour tokens

Status: Accepted · Date: 2026-11-22

## Context

Hunt shipped one look: near-black with neon cyan and green
glows, Space Grotesk and JetBrains Mono. A second look,
Dawn, takes its palette from the logo instead: blue-hour
grounds, cream text and the logo's gold sun as the only
accent. Some people prefer the original, so the user picks.

Colours were written as hex literals across 25 components
and the phone page, so a second look could not be added
without touching every one of them.

## Options considered

- **Two stylesheets.** Duplicates every rule; they drift.
- **A React theme context.** Re-renders the tree on change
  and does nothing for the phone page.
- **CSS custom properties on `<html>`.** Both apps already
  style through CSS, and swapping one attribute repaints
  without any re-render.

## Decision

Every colour is a token on `:root`, written as `R G B`
channels so Tailwind can add opacity (`bg-accent/20`).
`:root` and `[data-theme="neon"]` hold the original values.
`[data-theme="dawn"]` redefines the same names. Glows and
font faces are tokens too. Dawn sets the glows to `none`.

- Desktop: tokens in `src/app/globals.css`, mapped to
  Tailwind names in `tailwind.config.ts`. Tailwind's
  `white`, `black`, `neutral` and `slate` resolve to
  tokens, so existing classes follow the look.
- Phone: the same names in the `:root` block of
  `public/hunt-mobile.html`.
- Android widgets: RemoteViews cannot read CSS, so
  `res/values/colors.xml` mirrors the tokens as
  `widget_neon_*` and `widget_dawn_*`, and every widget
  layout has a `_neon` and a `_dawn` twin with the same
  view ids. The widget snapshot carries the look name and
  `WidgetLook.java` picks the set. A test keeps the colours
  equal to both CSS token blocks and the twins in step.
  Font faces: a widget's `TextView` cannot load
  `res/font` (the launcher inflates it with a restricted
  context), so the display type (the day title, the
  Stats figure) is drawn into a bitmap in the look's
  bundled face (`WidgetDisplayText`, OFL licences in
  `assets/licenses/`); body text uses the system sans.
- Roles (`accent`, `success`, `warning`, `danger`, `now`)
  are separate from quest colours (`q-cyan` … `q-lime`).
  In Neon they share values; in Dawn they do not.
- Quest colour keys stored in data are unchanged.

The choice is per device and is not synced. It is kept
under `hunt-look` in `localStorage`. An inline script in
the document head applies it before first paint, so the
page never flashes the other look.

## Consequences

- New UI uses token classes (`bg-surface`, `text-accent`).
  A hex literal in a component is a review finding.
- Dawn-only details (serif titles, sentence-case labels,
  the Focus sun arc) hang off `[data-theme="dawn"]` in CSS
  rather than branches in components.
- Two devices can show different looks. That is intended.
