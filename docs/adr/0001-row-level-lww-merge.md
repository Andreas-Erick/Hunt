# ADR-0001: Row-level last-write-wins merge

Status: Accepted · Date: 2026-11-22

## Context

Desktop and phone edit the same quests, tasks, habits and
time logs while offline, then exchange full snapshots. The
merge must give the same result whichever device syncs
first and however often a sync is retried. It must also run
unchanged on the sync server, in the desktop app, and on
the phone.

## Options considered

- **Op-log CRDT library (Automerge, Yjs).** Correct under
  any clock, but adds a dependency and a binary document
  format, and is hard to inspect by hand. Character-level
  merging isn't needed: rows here are small.
- **Server decides, clients overwrite.** Simple, but loses
  offline edits from whichever device syncs second.
- **Per-row LWW with deterministic tie-breaks.** Small,
  readable pure functions. Correctness depends on stamps.

## Decision

Per-row LWW in `src/lib/syncTypes.ts`, with rules R1–R6
documented on its helpers. The main ones:

- The higher `updatedAt` wins. Equal stamps fall back to a
  content comparison, so ties resolve the same way
  everywhere (R1).
- Two versions of one time log keep the earlier end (R2).
  Log ids are deterministic per focus session (R3).
- Deletions are tombstones, one list per collection.
- Local stamps only move forward:
  `max(now, previous + 1)` (R6, `taskQueue.ts`).

Each collection's rules sit in one typed table inside
`mergeSyncPayloads`. tsc rejects a table that misses a
collection. `syncProperties.test.ts` checks commutativity,
associativity and idempotence over 400 seeds.

## Consequences

- No CRDT dependency, and the merge is easy to read.
- A device whose clock runs fast wins real conflicts. This
  is accepted for one user with a few devices.
- Tombstone lists are capped at 5,000 per collection
  (`MAX_TOMBSTONES_PER_KIND`). A device offline long enough
  to miss more deletions than that can bring old rows back.
- A Task's Checklist is stored on the Task row and merges
  with it as one row. Two devices that edit the same
  Checklist while apart keep only the newer row's items.
  This is accepted: Checklists are short and edited on one
  device at a time.
- Standalone Lists are a synced collection of their own
  (`lists`, tombstones in `deletedListIds`). A List's items
  live on the List row and merge with it, as a Checklist
  does with its Task: two devices that edit the same List
  while apart keep only the newer row's items. Payloads
  from older devices carry no `lists` and read as none.
- A Habit's Frequency history (`frequencyHistory`) is also a
  list stored on its row: if two devices change the
  Frequency while apart, the later Habit row wins with its
  whole history. The validator rebuilds the list from known
  shapes only (`sanitizeHabitFrequencyHistory`), so it stays
  bounded.
- A Skipped Habit Week (N times per week) has no row of its
  own. The Skip is the `skipped` flag on the day Task of the
  day it was made (`habitSkipRows`), and the week reads
  Skipped while any of its day Tasks carries the flag. So a
  Skip races only with a tick of that same day, never with
  another day's row, and the week's Outcome is a function of
  the merged rows, whatever order they arrive in. Undo clears
  the flag on every day Task of the week; a Skip made on one
  device for a different day while the other undoes keeps
  the week Skipped. This is accepted: Skipping is rare, and
  Undo can be repeated.
- A Habit's end date (`endDate`) and the stretches it spent
  Ended before a restart (`endedSpans`) ride on its row the
  same way: the later Habit row wins with both. The
  validator keeps only valid date keys
  (`sanitizeHabitEnd`), at most 100 stretches.
- A new synced collection needs a type in `SyncPayload`,
  an entry in `TOMBSTONE_KEY`, a row in the merge table, a
  validator (in its own module: `lists.ts` for Lists), a
  Dexie table in a new schema version, and a slot in the
  phone's saved state (`getEmptyState`, `guardSyncState`).
