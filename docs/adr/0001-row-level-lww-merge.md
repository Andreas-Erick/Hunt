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
- A list stored inside a row merges with that row. A Habit's
  Frequency history (`frequencyHistory`) is one such list: if
  two devices change the Frequency while apart, the later
  Habit row wins with its whole history. The validator
  rebuilds the list from known shapes only
  (`sanitizeHabitFrequencyHistory`), so it stays bounded.
- A new synced collection needs a type in `SyncPayload`,
  an entry in `TOMBSTONE_KEY`, a row in the merge table, a
  validator, and a Dexie table.
