# Hunt coding standards (review)

Read at review time. Judge the diff against every rule below and cite `file:line` for each violation. Mechanical rules are already enforced by tests: UI rules in `src/__tests__/sourceScan_uiGuardrails.test.ts`, and repo rules (README facts, phone-readable Markdown, test naming, module size, layering) in `src/__tests__/repoGuardrails.test.ts` and `architectureTopology.test.ts`. This file holds the judgement calls a scanner cannot make.

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

## Shared rules

- **One implementation**: a rule both devices run (merge, stamps, focus transitions, habit rows, log rows) lives in a pure `src/lib` module and reaches the phone through `src/mobile/huntCore.ts`. The phone page holds rendering and wiring: it calls `HuntCore.*`, and a diff that adds domain logic to `public/hunt-mobile.html` moves it into the core instead.
- **Synced data**: a new synced field or collection goes through the merge table in `syncTypes.ts`, the validator, and a parity or property test in the same diff.

## Failure paths

- **Unreadable data**: when stored data can't be read, the code keeps a copy before anything replaces it, logs which file and why, and tells the user what happened and how to recover (sync from the laptop, retry). Resetting to an empty state is a visible event, never a silent one.
- **Empty catch**: a catch that swallows an error names in a comment why losing it is safe (private-mode storage, best-effort scroll). Anything that can lose user data reports it.

## Tests

- **Behaviour**: a test renders, calls, or fires the event and asserts on what the user or caller sees. Each new rule or fix gets a test that fails without it.
- **Seeded**: a randomised test uses a fixed seed and puts the seed in its failure message, so a failure replays.

## Docs follow code

- **ADRs**: a diff that changes a decision recorded in `docs/adr/` updates that ADR (or adds a superseding one) in the same diff.
- **README**: a diff that changes something the README claims (commands, behaviour, guarantees) updates the README in the same diff.
