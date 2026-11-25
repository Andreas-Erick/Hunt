# ADR-0008: Habit days are Task rows

Status: Accepted · Date: 2026-11-25

## Context

A Habit asks for days (its Frequency), and each scheduled
day needs something to tick, count, Skip or focus on. The
desktop, the phone and the Widgets all create these days,
often offline and on the same date. Row-level LWW
(ADR-0001) merges rows by id, so two devices that each
invent their own row for one day would sync as two rows.
The day should also show up wherever a Task does: Today's
queue, Focus, reminders and the Widgets.

## Options considered

- **A separate HabitDay collection.** A clean model, but a
  new synced collection (ADR-0001's checklist), and Focus,
  the queue, reminders and the Widgets would each need a
  second path for habit days.
- **Derived only.** Compute each day from the Habit and
  its logs, with no row. Nothing to sync, but a tick, a
  Count total or a Skip still has to be stored somewhere,
  and Focus needs a Task to run against.
- **Task rows with deterministic ids.** Each day is an
  ordinary Task row whose id both devices compute the same
  way.

## Decision

A Habit day is a Task row with `habitId` and
`scheduledDate` set. Its id comes from `habitTaskId` in
`src/lib/dateUtils.ts`:

```ts
habtsk-${dateKey}-${habitId}
```

`buildHabitTaskRow` in `src/lib/taskQueue.ts` builds the
row, stamped with the Habit's `createdAt`, so two devices
build the same row byte for byte. `missingHabitRows` lists
the rows a date still lacks: it skips an existing or
tombstoned id, and Habits that don't ask for the day (an N
per week Habit whose Habit Week is Met or Skipped).

- **Desktop.** `localStore.materializeHabits` writes the
  missing rows for today. The command store calls it at
  boot, when Today or Habits opens, after a sync that
  changed data, and after a snapshot import
  (`useCommandStore.ts`). Creating a Habit writes today's
  row at once.
- **Phone.** `materializeDailyHabitsInto` in
  `public/hunt-mobile.html` calls the same
  `HuntCore.missingHabitRows` when a Habit is created,
  after every sync's merge, and when the date rolls over
  with Hunt open.

## Consequences

- Two offline devices create the same row id for the same
  day, so a sync merges them into one row. Habit days need
  no merge rule of their own.
- Habit days reuse Focus, the queue, reminders (a Habit
  reminder's action ticks its day Task by its fixed id,
  ADR-0007) and the Widgets, which can tick a Habit before
  Hunt has run that day (ADR-0006).
- The id format is a sync contract. Changing it would
  duplicate every day already synced, so it needs a
  migration that rewrites old ids on both devices.
- Deleting a Habit tombstones the Habit and removes only
  today's untouched day Task (still queued, no focused
  time). A ticked or focused row stays as history, on both
  devices. A tombstoned day id is never built again.
- Every Habit adds up to one row per scheduled day, and
  those rows count toward `MAX_SYNC_TASKS` (100,000) in
  `src/lib/syncTypes.ts`, shared with ordinary Tasks.
- Habits themselves are capped at `MAX_SYNC_HABITS` (200).
  A payload over a cap is rejected whole (ADR-0001), so
  both devices refuse to create a Habit at the cap instead
  of letting sync wedge.
