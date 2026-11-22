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
  `readPendingTicks`, applies it with HuntCore's
  `applyPendingTicks`, saves, then calls `ackPendingTicks`
  with the ticks it read. The shell removes exactly those,
  so a tick queued meanwhile survives. While the page
  cannot save, it acknowledges nothing.
- A stale tick (Task gone, already done, archived, or in
  Focus) is skipped and logged, never forced through.
- While Hunt is running, the queue announces each newly
  appended tick to the live Activity, which calls
  `window.__huntPendingTicksArrived` once the page has
  loaded. The page runs the same drain, then repaints. It
  also drains on resume, for a signal that found no page.
  Ticks it acknowledged stay out of later drains until
  the shell has removed them.
