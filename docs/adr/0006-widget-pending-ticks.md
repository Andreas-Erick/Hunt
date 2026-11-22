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
it to hide queued tasks. Hunt drains it through HuntCore
on its next start, or at once if it is already running.

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
  so a tick queued meanwhile survives. While the page
  cannot save, it acknowledges nothing.
- A stale tick (Task gone, already done, archived, or in
  Focus) is skipped and logged, never forced through.
- No tick is dropped silently. A queue the shell cannot
  read is never written over. If it will not parse, the
  page's read moves it aside and names the copy in
  `keptAs`. If the read itself failed, it stays in place
  for the next read. Either way the page logs it and tells
  the user. A tick the queue refuses (unreadable, full, a
  failed write) keeps its Undo window, stays hidden, and is
  offered again on the next redraw or read. The read
  reports these as `heldBack` for diagnostics.
- A tick first opens a 4-second Undo window: the row shows
  "✓ Done · Undo" and the tick is appended to the queue
  only when the window ends, still with the tap time.
  Undo closes the window, so nothing is ever queued. Open
  windows live in the widget's private preferences, written
  before the tap returns; a main-thread timer ends them on
  time, and an inexact alarm, every widget redraw and the
  page's queue read end any the timer missed because the
  process was gone. No new permission.
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
