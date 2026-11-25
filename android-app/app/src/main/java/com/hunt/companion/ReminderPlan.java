package com.hunt.companion;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * The Reminder Plan (ADR-0007) as the shell reads it: the reminders HuntCore's reminderPlan
 * picked, earliest first. Which reminders are due is never decided here; this only answers
 * which of them to post now and when to wake next. Plain Java, so it runs in the JDK probes.
 */
final class ReminderPlan {
    /** The plan shape this shell understands; any other version reads as no reminders. */
    static final int VERSION = 1;
    /** The most entries kept (HuntCore's REMINDER_PLAN_MAX), the earliest ones. */
    static final int MAX_ENTRIES = 64;
    /** A reminder missed by more than this (phone off, alarm late) is dropped, as on the desktop. */
    static final long LATE_LIMIT_MS = 10 * 60_000L;

    /** One reminder: what to show, the notification tag, and what a tap opens. */
    static final class Entry {
        /** Stable per item and fire time; posted once, and the notification tag. */
        final String key;
        /** "task" today; habit reminders arrive later. Passed back to the page as is. */
        final String kind;
        final String itemId;
        final String title;
        /** The day the reminder is for (YYYY-MM-DD, local). */
        final String dateKey;
        /** Epoch ms. */
        final long fireAt;

        Entry(String key, String kind, String itemId, String title, String dateKey, long fireAt) {
            this.key = key;
            this.kind = kind;
            this.itemId = itemId;
            this.title = title;
            this.dateKey = dateKey;
            this.fireAt = fireAt;
        }
    }

    /** Earliest first. */
    final List<Entry> entries;

    private ReminderPlan(List<Entry> entries) {
        this.entries = Collections.unmodifiableList(entries);
    }

    /**
     * Reads the page's plan JSON. Blank, unparsable or another version: no reminders (the page
     * writes a fresh plan on its next save). Entries that are not reminders are skipped.
     */
    static ReminderPlan parse(String json) {
        List<Entry> out = new ArrayList<>();
        if (json == null || json.trim().isEmpty()) return new ReminderPlan(out);
        JSONArray list;
        try {
            JSONObject root = new JSONObject(json);
            if (root.optLong("version", -1) != VERSION) return new ReminderPlan(out);
            list = root.optJSONArray("reminders");
        } catch (JSONException | RuntimeException e) {
            return new ReminderPlan(out);
        }
        for (int i = 0; list != null && i < list.length(); i++) {
            Entry e = entryOf(list.optJSONObject(i));
            if (e != null) out.add(e);
        }
        Collections.sort(out, (a, b) -> Long.compare(a.fireAt, b.fireAt));
        return new ReminderPlan(out.size() > MAX_ENTRIES ? new ArrayList<>(out.subList(0, MAX_ENTRIES)) : out);
    }

    private static Entry entryOf(JSONObject o) {
        if (o == null) return null;
        Object fireAt = o.opt("fireAt");
        String key = o.optString("key", "");
        String itemId = o.optString("itemId", "");
        if (!(fireAt instanceof Number) || key.isEmpty() || itemId.isEmpty()) return null;
        return new Entry(key, o.optString("kind", ""), itemId, o.optString("title", ""),
                o.optString("dateKey", ""), ((Number) fireAt).longValue());
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
