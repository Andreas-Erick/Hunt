# ADR-0006: Widget ticks are queued, not written

Status: Accepted · Date: 2026-11-22

## Context

The Day Widget lets the user tick a task done from the
Android home screen, while the Hunt app may be closed. The
widget is native code (RemoteViews) and cannot run the
WebView. Completing a task touches merge stamps (ADR-0001)
and habit rules that live only in HuntCore (ADR-0003).

## Options considered

- **Java writes the state file.** Instant, but duplicates
  the completion and stamp rules in Java: the drift that
  ADR-0003 exists to prevent.
- **Hidden background WebView per tick.** Reuses HuntCore,
  but cold-starts slowly and fights Android background
  limits.
- **Pending ticks.** The widget appends "task X ticked at
  T" to a queue file and hides the task. Hunt applies the
  queue through HuntCore, with T as the completion time.

## Decision

Pending ticks. The Android shell owns a queue file beside
the state file. The widget only appends to it and reads
it to hide each queued task on the day it was ticked
for. Hunt drains it through HuntCore on its next start,
or at once if it is already running.

## Consequences

- No Hunt rule is reimplemented in Java.
- The desktop sees a widget tick only after the phone app
  next opens and syncs.
- The task currently in Focus is not tickable from the
  widget, because finishing it would need a TimeLog and a
  Focus transition.
- The queue is `hunt-pending-ticks.json`, a JSON array of
  `{taskId, dateKey, tickedAt}`. The page reads it with
  `readPendingTicks`, which answers
  `{ticks, heldBack?, unreadable?, keptAs?}`, applies it
  with HuntCore's
  `applyPendingTicks`, saves, then calls `ackPendingTicks`
  with the ticks it read. The shell removes exactly those,
  so a tick queued meanwhile survives. Applied ticks ask
  for a sync like any other change. While the page cannot
  save, it applies and acknowledges nothing: the ticks
  wait, untouched, until the user lets Hunt save again.
- A stale tick (Task gone, already done, archived, or in
  Focus) is skipped and logged, never forced through.
- A Count Habit row's tap is a `+1`, not a done tick: the
  Widget Snapshot (version 2) gives each Habit row its
  `habitKind` and a Count row its ready-made `progress`
  ("2 / 3 miles"). The queue entry carries `"kind":"+1"`,
  and one is queued per tap (the same tap twice still
  once), each with its own Undo window ("+1 · Undo"). A
  `+1` never hides its row; the row shows the `+1`s on
  their way after the snapshot's progress. HuntCore adds
  one through the shared Count rule and records the tap
  time on the day Task (`countTickedAt`), so a `+1` read
  again before the shell removed it is skipped as
  `already-counted`. A `+1` on a row that is not a Count
  Habit's day, or a done tick on one that is, is skipped
  as `wrong-kind`.
- An Avoid Habit row's tap logs a Slip: the Widget Snapshot
  (version 3) gives the row `habitKind: "avoid"` and the
  `progress` "Kept so far". The queue entry carries
  `"kind":"slip"`, behind the same Undo window ("Slip ·
  Undo"). Like a done tick it is queued once per Task and
  day and hides its row, since one Slip already makes the
  day Missed; a day with a Slip is left out of the snapshot.
  HuntCore logs it through the shared Slip rule (the day
  Task's `slips`), and skips it as `already-slipped` when
  the day already has one, so a `slip` read again is
  applied once. A `slip` on any other row, or a done or
  `+1` tick on an Avoid row, is `wrong-kind`.
- No tick is dropped silently. A queue the shell cannot
  read is never written over. If it will not parse, the
  page's read moves it aside and names the copy in
  `keptAs`; entries that are not tick objects are copied
  aside the same way and dropped from the queue, so they
  never fill it. If the read itself failed, it stays in
  place for the next read. Either way the page logs it and
  tells the user. While the widget cannot read the queue,
  it offers no tick at all: it cannot tell which tasks are
  already queued, and showing them tickable again would
  contradict "they stay saved". Remembering the last good
  read was rejected: it is lost with the process. A tick
  the queue refuses (unreadable, full, a failed write)
  keeps its Undo window, stays hidden, and is offered
  again on the next redraw or read. The read
  reports these as `heldBack` for diagnostics.
- A tick first opens a 4-second Undo window: the row shows
  "✓ Done · Undo", then hides, and the tick is appended to
  the queue 1.5 seconds after the window ends, still with
  the tap time (`LATE_UNDO_MS`), because an Undo tapped
  near the end reaches the widget 100-300 ms later
  (launcher, PendingIntent, trampoline); it must still
  find the window. Undo closes the window, so nothing is
  ever queued. An Undo that arrives after the tick was
  queued tells the user to untick it in Hunt. Open
  windows live in the widget's private preferences, written
  before the tap returns; a main-thread timer ends them on
  time, and an inexact alarm, every widget redraw and the
  page's queue read end any the timer missed because the
  process was gone. No new permission. A tap whose write
  fails is never silent: the widget shows a short message.
  An Undo that cannot be written is still kept out of the
  queue by the running process, which retries it.
- Row taps go to a no-UI, non-exported trampoline activity,
  not a broadcast. A receiver that starts Hunt is a
  background activity launch, which Android 10+ blocks
  without an exemption, and from Android 14 a launcher no
  longer lends its exemption to a PendingIntent it sends
  unless it opts in. An activity PendingIntent from a widget
  tap is a launch the user started, on every API level.
- While Hunt is running, the queue announces each newly
  appended tick to the live Activity, which calls
  `window.__huntPendingTicksArrived` once the page has
  loaded. The page runs the same drain, then repaints. It
  also drains on resume, for a signal that found no page.
  Ticks it acknowledged stay out of later drains until
  the shell has removed them.
- From API 31 the Day Widget's rows ride inside its own
  RemoteViews (`RemoteCollectionItems`), not through
  `DayWidgetService`. For a list served by an Intent the
  system sends the launcher only "update deferred", which
  it may apply late, so the day title lagged the rows
  after ‹ › or a look change. Before API 31 the service
  still serves the rows. The arrows' broadcast is
  foreground, so a cached app gets it at once.
