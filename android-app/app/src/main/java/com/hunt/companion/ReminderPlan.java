package com.hunt.companion;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * The Reminder Plan (ADR-0007) as the shell reads it: the reminders HuntCore's reminderPlan
 * picked, earliest first, each with the Pending Tick its Done or +1 action writes. Which
 * reminders are due is never decided here; this only answers which of them to post now and when
 * to wake next, and re-posts a Snooze the page has not planned yet ({@link #withSnoozes}).
 * Plain Java, so it runs in the JDK probes.
 */
final class ReminderPlan {
    /** The plan shape this shell understands; any other version reads as no reminders. */
    static final int VERSION = 1;
    /** The most entries kept (HuntCore's REMINDER_PLAN_MAX), the earliest ones. */
    static final int MAX_ENTRIES = 64;
    /** A reminder missed by more than this (phone off, alarm late) is dropped, as on the desktop. */
    static final long LATE_LIMIT_MS = 10 * 60_000L;

    /** One reminder: what to show, the notification tag, what a tap opens and what its actions write. */
    static final class Entry {
        /** Stable per item and fire time; posted once, and the notification tag. */
        final String key;
        /** "task" or "habit". Passed back to the page as is. */
        final String kind;
        final String itemId;
        final String title;
        /** The day the reminder is for (YYYY-MM-DD, local). */
        final String dateKey;
        /** Epoch ms. */
        final long fireAt;
        /** The tick Done or +1 queues ("done" or "+1"), or null when the notification offers only Snooze. */
        final String actionTick;
        /** The Task that tick names (a Habit's day Task for a habit reminder). */
        final String actionTaskId;
        /** On a snoozed reminder, the original's key and fire time; null otherwise. */
        final String snoozeOfKey;
        final long snoozeOfFireAt;

        Entry(String key, String kind, String itemId, String title, String dateKey, long fireAt,
              String actionTick, String actionTaskId, String snoozeOfKey, long snoozeOfFireAt) {
            this.key = key;
            this.kind = kind;
            this.itemId = itemId;
            this.title = title;
            this.dateKey = dateKey;
            this.fireAt = fireAt;
            this.actionTick = actionTick;
            this.actionTaskId = actionTaskId;
            this.snoozeOfKey = snoozeOfKey;
            this.snoozeOfFireAt = snoozeOfFireAt;
        }

        /** The original reminder's key: this one's, or the one it snoozes. */
        String baseKey() {
            return snoozeOfKey != null ? snoozeOfKey : key;
        }

        /** The original reminder's fire time. */
        long baseFireAt() {
            return snoozeOfKey != null ? snoozeOfFireAt : fireAt;
        }

        /** The entry in the plan's JSON shape, for a notification action's intent and the snooze file. */
        String toJson() {
            return toJsonObject().toString();
        }

        JSONObject toJsonObject() {
            try {
                JSONObject o = new JSONObject().put("key", key).put("kind", kind).put("itemId", itemId)
                        .put("title", title).put("dateKey", dateKey).put("fireAt", fireAt);
                if (actionTick != null) o.put("action", new JSONObject().put("tick", actionTick).put("taskId", actionTaskId));
                if (snoozeOfKey != null) o.put("snoozeOf", new JSONObject().put("key", snoozeOfKey).put("fireAt", snoozeOfFireAt));
                return o;
            } catch (JSONException e) {
                throw new IllegalStateException(e); // only put() with a null key throws
            }
        }

        /** {@link #toJson} read back; null when it is not a reminder. */
        static Entry fromJson(String json) {
            if (json == null) return null;
            try {
                return entryOf(new JSONObject(json));
            } catch (JSONException | RuntimeException e) {
                return null;
            }
        }
    }

    /** One stored Snooze ({@link ReminderSnoozes}): the snoozed reminder and when it fires again. */
    static final class Snooze {
        final Entry reminder;
        final long until;

        Snooze(Entry reminder, long until) {
            this.reminder = reminder;
            this.until = until;
        }
    }

    /** Earliest first. */
    final List<Entry> entries;
    /** {@link #snoozeId} of every Snooze the page judged when it built this plan. */
    private final Set<String> judgedSnoozes;

    private ReminderPlan(List<Entry> entries, Set<String> judgedSnoozes) {
        this.entries = Collections.unmodifiableList(entries);
        this.judgedSnoozes = judgedSnoozes;
    }

    private static ReminderPlan empty() {
        return new ReminderPlan(new ArrayList<>(), new HashSet<>());
    }

    /**
     * Reads the page's plan JSON. Blank, unparsable or another version: no reminders (the page
     * writes a fresh plan on its next save). Entries that are not reminders are skipped.
     */
    static ReminderPlan parse(String json) {
        if (json == null || json.trim().isEmpty()) return empty();
        JSONArray list;
        JSONArray snoozes;
        try {
            JSONObject root = new JSONObject(json);
            if (root.optLong("version", -1) != VERSION) return empty();
            list = root.optJSONArray("reminders");
            snoozes = root.optJSONArray("snoozes");
        } catch (JSONException | RuntimeException e) {
            return empty();
        }
        List<Entry> out = new ArrayList<>();
        for (int i = 0; list != null && i < list.length(); i++) {
            Entry e = entryOf(list.optJSONObject(i));
            if (e != null) out.add(e);
        }
        Set<String> judged = new HashSet<>();
        for (int i = 0; snoozes != null && i < snoozes.length(); i++) {
            JSONObject s = snoozes.optJSONObject(i);
            if (s != null) judged.add(snoozeId(s.optString("key", ""), s.optLong("until", 0L)));
        }
        return of(out, judged);
    }

    private static ReminderPlan of(List<Entry> out, Set<String> judged) {
        Collections.sort(out, (a, b) -> Long.compare(a.fireAt, b.fireAt));
        return new ReminderPlan(out.size() > MAX_ENTRIES ? new ArrayList<>(out.subList(0, MAX_ENTRIES)) : out, judged);
    }

    private static String snoozeId(String key, long until) {
        return key + " " + until;
    }

    private static Entry entryOf(JSONObject o) {
        if (o == null) return null;
        Object fireAt = o.opt("fireAt");
        String key = o.optString("key", "");
        String itemId = o.optString("itemId", "");
        if (!(fireAt instanceof Number) || key.isEmpty() || itemId.isEmpty()) return null;
        String tick = null;
        String taskId = null;
        JSONObject action = o.optJSONObject("action");
        if (action != null && !action.optString("tick", "").isEmpty() && !action.optString("taskId", "").isEmpty()) {
            tick = action.optString("tick");
            taskId = action.optString("taskId");
        }
        String snoozeOfKey = null;
        long snoozeOfFireAt = 0L;
        JSONObject snoozeOf = o.optJSONObject("snoozeOf");
        if (snoozeOf != null && !snoozeOf.optString("key", "").isEmpty()) {
            snoozeOfKey = snoozeOf.optString("key");
            snoozeOfFireAt = snoozeOf.optLong("fireAt", 0L);
        }
        return new Entry(key, o.optString("kind", ""), itemId, o.optString("title", ""),
                o.optString("dateKey", ""), ((Number) fireAt).longValue(), tick, taskId, snoozeOfKey, snoozeOfFireAt);
    }

    /**
     * This plan plus a stand-in for each stored Snooze the page has not judged yet (stored after
     * the page built the plan): the snoozed reminder again at the snooze's end, with the same
     * actions, keyed as HuntCore keys it (original key, "~", until). A Snooze the page judged is
     * the page's to post or to drop, which it does when the item was finished meanwhile.
     */
    ReminderPlan withSnoozes(List<Snooze> snoozes) {
        List<Entry> out = new ArrayList<>(entries);
        boolean added = false;
        for (Snooze s : snoozes) {
            Entry r = s.reminder;
            if (judgedSnoozes.contains(snoozeId(r.baseKey(), s.until))) continue;
            out.add(new Entry(r.baseKey() + "~" + s.until, r.kind, r.itemId, r.title, r.dateKey, s.until,
                    r.actionTick, r.actionTaskId, r.baseKey(), r.baseFireAt()));
            added = true;
        }
        return added ? of(out, judgedSnoozes) : this;
    }

    /**
     * The reminders to post at `now`: due after `firedThrough` (the last time reminders were
     * posted, so none is posted twice) and missed by at most LATE_LIMIT_MS.
     */
    List<Entry> due(long firedThrough, long now) {
        long after = Math.max(firedThrough, now - LATE_LIMIT_MS);
        List<Entry> out = new ArrayList<>();
        for (Entry e : entries) {
            if (e.fireAt > after && e.fireAt <= now) out.add(e);
        }
        return out;
    }

    /** When the next alarm should ring: the earliest reminder after `now`, or -1 for none. */
    long nextAlarmAt(long now) {
        for (Entry e : entries) {
            if (e.fireAt > now) return e.fireAt;
        }
        return -1;
    }
}
