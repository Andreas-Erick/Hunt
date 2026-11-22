# Hunt coding standards (review)

Read at review time. Judge the diff against every rule below and cite `file:line` for each violation. Mechanical rules (no `transition-all`, hover-revealed buttons, 16–20px buttons, short text-xs chips) are already enforced by `src/__tests__/sourceScan_uiGuardrails.test.ts`; this file holds the judgement calls a scanner cannot make.

## Touch and safety

Hunt runs on touch tablets as well as the desktop launcher (desktop React app *and* `public/hunt-mobile.html`).

- **Targets**: every new control reaches 32px on fine pointers and 44px on coarse ones, through padding, `min-h-*`, or a `before:-inset-*` hit area. Neighbouring controls sit at least 8px apart (`gap-2`).
- **Destructive placement**: Delete / Discard / End session sits on the opposite edge from the affirmative action (`mr-auto` / `justify-between`) and uses a quieter style than the primary. Arming a two-step delete never moves the button the user is about to press.
- **One primary**: each view, drawer, sheet footer, or form has one filled primary button; companions are secondary (outline/surface) or ghost.
- **Honest icons**: an icon-only control that ends work in progress (stops a timer, discards a draft) carries a visible label.

## Layout

- **User text**: every flex child holding user text has `min-w-0` plus a wrap or clamp (`break-words` / `[overflow-wrap:anywhere]` / `line-clamp-*`); its sibling buttons and badges are `shrink-0 whitespace-nowrap`.
- **Centred columns**: an `items-center` column holding user text gives its content `w-full` so an unbroken string cannot size it past the viewport.
- **Popovers**: a dropdown anchors to the edge its trigger sits on at *every* breakpoint where the layout changes (check the parent's `flex-col` → `flex-row` switch).
- **Scrollers**: an `overflow-x-auto` strip holding focusable items has `px-1 py-1` (or matching negative margin) so focus rings are not clipped.
- **Live numbers**: timers, counters, and durations that change while visible use `tabular-nums`.

## Motion

- **Layout shifts**: an element that mounts or unmounts mid-flow animates its height (or reserves space) instead of jumping the content below it.
- **Hot paths**: per-frame or per-keystroke updates touch only what changed — no whole-view re-render (phone `renderApp()`) for a pointer scrub, and no parent re-render of every list item per keystroke.
