# ADR-0007: Reminders fire on both devices

Status: Accepted · Date: 2026-11-25

## Context

A dated Task can get one reminder time, and a Habit one
or more. The user works at the desktop and
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
queued or in Focus. A Habit reminder
(`src/lib/habitReminders.ts`) is due at each of the
Habit's `reminderTimes` on each day whose Outcome, judged
on that day by the shared `habitDayOutcome`, is Open: a
Met, Skipped or unscheduled day stays quiet, and so does
any day the Outcome rule closes (an Ended Habit). An N
per week day is Open on its own, so its Habit Week
(`habitWeekOf`) is read too: once the week holds N Met
days, or was set aside (Skipped), its other days stay
quiet. Habit Kinds need no rule of their own
here: an Avoid Habit's day stays Open until a Slip, so
its evening reminder is a check-in. Each answer carries
a `kind` (`task` or `habit`) and a `key`
(`task:<id>:<date>T<time>`, `habit:<id>:<date>T<time>`)
that is stable per item and time. Snoozes are folded
into the same rule (see Consequences).

Each device re-plans after every save and every sync.

- **Desktop.** While the launcher's window is open, one
  timer is set for the next due reminder
  (`reminderAlarm.ts`). A Dexie live query over the undone
  Tasks, the Habits and their day Tasks from yesterday on
  re-plans it on any write, local or synced. When it rings
  it re-reads them before asking the rule, so an item
  finished in the meantime stays quiet. It shows a Web
  Notification, which the launcher's Chromium window turns
  into a Windows notification. The notification tag is the
  reminder key, so two windows replace each other's toast
  instead of stacking. A click focuses Hunt; a Habit's
  opens Habits at its card (with the service worker, the
  worker hands the click to the window, which opens it).
- **Phone.** After every save (a sync's merge is saved
  too), at boot and at the start of each day, the page
  hands the shell a Reminder Plan: HuntCore's
  `reminderPlan(sources, now)` in `src/lib/reminderPlan.ts`,
  the rule's answer from 10 minutes ago to 7 days ahead,
  at most 64 entries. The shell writes it to its own file
  and arms one alarm for the next entry, exact when
  Android allows it, with Hunt open or closed. When the
  alarm rings it posts each due entry once (it remembers
  when it last posted), drops one missed by more than 10
  minutes, and arms the next. A reboot, a clock or time
  zone change, an update or an exact-alarm grant re-arms
  it. The notification tag is the reminder key. A tap
  opens Hunt on the item (a Task's options; a Habit's
  sheet on Habits); an item gone since just opens Hunt.
  The shell decides nothing about what is due; it only
  picks the notification's text by `kind`.

## Consequences

- No new server, push channel or account.
- Duplicates are suppressed by sync, not prevented. A
  Task done on one device stays quiet on the other once
  that device has synced. Before then, both may fire.
- Notification actions. HuntCore picks each reminder's
  action (`reminderAction` in `src/lib/reminderActions.ts`):
  Done on a Task or a Check Habit's day, +1 on a Count
  Habit's day, none on an Avoid Habit's check-in; every
  notification also offers Snooze 10 min. On the phone
  the Reminder Plan carries each entry's `action`
  (`{tick, taskId}`, a Habit's day Task by its fixed id),
  and Done or +1 only appends that Pending Tick
  (ADR-0006), applied through HuntCore when Hunt next
  runs, or at once if it is running; a second press of
  the same tap is queued once, and applying it again
  skips it. There is no Undo window: the user pressed a
  labelled button. On the desktop the buttons need a
  service worker (`public/hunt-reminder-sw.js`, no fetch
  handling, no cache), which hands a press to one open
  window; that window applies it through the command
  store. Without a service worker (a tablet on plain
  http) the notification has no buttons. No action
  writes Hunt data outside HuntCore's rules.
- Snooze is device-local and never synced. A Snooze
  stores `{key, fireAt, until}` of the original reminder
  (`src/lib/reminderSnooze.ts`); `dueReminders` folds
  stored snoozes in, so one re-fires at `until`, keyed
  `<key>~<until>`, only while the original would still
  be due: an item finished meanwhile stays quiet. A
  second Snooze moves the same snooze. The desktop keeps
  snoozes in localStorage. The phone's shell keeps them
  in its own file (`hunt-reminder-snoozes.json`), which
  the page reads through the bridge for its next plan;
  the plan lists the snoozes it judged, and until the
  page plans again (Hunt closed) the shell re-posts a
  newer snooze itself, as its stand-in.
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
  reminder is set, plus the boot permission to re-arm
  after a restart. When one is missing, the reminder
  field says so (notifications off: reminders won't
  arrive; no exact alarms: they may arrive late) and
  offers Allow, which opens Android's dialog or the
  setting. Without the exact-alarm grant the shell arms
  an inexact alarm instead.
- A phone left closed for more than 7 days stops
  reminding until Hunt is opened again; the plan is
  rebuilt on every open. Its fire times are computed in
  the time zone the page last ran in. Many Habit times
  can fill the 64 entries before 7 days; the plan is
  rebuilt each day, so this only shortens how long a
  closed phone keeps reminding.
- A phone plan built before a day is Met still holds
  that day's Habit reminder until the next save or sync
  replaces it; ticking the Habit is a save, so on the
  device it was ticked on it goes quiet at once.
- A reminder time is validated as `HH:MM` by the sync
  validator and the phone's boundary guard; a Habit keeps
  at most 6, ascending, without repeats
  (`sanitizeHabitReminderTimes`). Each merges with its row
  under row-level last-write-wins (ADR-0001), so it needs
  no merge rule of its own. Habit reminder times save as
  soon as they change, as a Task's does, not with the
  Habit's edit form.
