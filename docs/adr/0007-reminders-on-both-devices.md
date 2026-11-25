# ADR-0007: Reminders fire on both devices

Status: Accepted · Date: 2026-11-25

## Context

A dated Task can get one reminder time, and Habits get
reminder times later. The user works at the desktop and
carries the phone, and wants a prompt on whichever is at
hand. There is no push service: the laptop is the only
hub (ADR-0002), and it is often off. Each device holds a
full copy of the data and syncs when it can.

## Options considered

- **The laptop decides and pushes to the phone.** One
  source of truth, but no phone reminder while the laptop
  is off, which is most of the day.
- **The phone only.** Exact alarms work with Hunt closed,
  but the user at the desk misses them.
- **Both devices fire from the same rule.** Each plans
  its own notifications from its own copy. Sync tells
  each one what the other already did.

## Decision

Both devices fire. One pure rule in HuntCore,
`dueReminders(sources, {from, to})` in
`src/lib/reminders.ts`, answers which reminders fall in a
window. A Task reminder is due on its `scheduledDate` at
its `reminderTime` (local `HH:MM`) while the Task is
queued or in Focus. Each answer carries a `key`
(`task:<id>:<date>T<time>`) that is stable per item and
time. Habit reminders and snoozes join the same rule and
the same `DueReminder` union later.

Each device re-plans after every save and every sync.

- **Desktop.** While the launcher's window is open, one
  timer is set for the next due reminder
  (`reminderAlarm.ts`). A Dexie live query over the undone
  Tasks re-plans it on any write, local or synced. When it
  rings it re-reads the Tasks before asking the rule, so a
  Task finished in the meantime stays quiet. It shows a
  Web Notification, which the launcher's Chromium window
  turns into a Windows notification. The notification tag
  is the reminder key, so two windows replace each other's
  toast instead of stacking.
- **Phone.** The Android shell schedules exact alarms for
  the next due reminders and posts notifications, with
  Hunt open or closed.

## Consequences

- No new server, push channel or account.
- Duplicates are suppressed by sync, not prevented. A
  Task done on one device stays quiet on the other once
  that device has synced. Before then, both may fire.
- Notification actions (Done, +1) are written as Pending
  Ticks and applied through HuntCore, as widget ticks are
  (ADR-0006). Snooze is stored by the device that showed
  the notification and folded into its next plan. No
  action writes Hunt data directly.
- A reminder missed by more than 10 minutes on the
  desktop (asleep, or the timer late) is dropped, not
  fired late. Reminders from before the window opened
  never fire. Nothing fires while the launcher is closed.
- A tablet on the LAN URL gets no notification: plain
  http is not a secure context, so it has no Notification
  API. It can still set reminder times, and they sync.
- Permissions. The desktop asks for the browser's
  notification permission the first time a reminder is
  set. When it was refused, the reminder field says how to
  allow it again. The phone needs the notification and
  exact-alarm permissions, asked for the first time a
  reminder is set.
- A reminder time is validated as `HH:MM` by the sync
  validator and the phone's boundary guard. It merges with
  its row under row-level last-write-wins (ADR-0001), so
  it needs no merge rule of its own.
