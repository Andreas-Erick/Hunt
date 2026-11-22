package com.hunt.companion;

import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.Locale;

/**
 * Which day the Day Widget shows and what it calls it, as plain rules: the ‹ › arrows reach today
 * to today + 6, a choice expires at local midnight, and the day is labelled "Today", "Tomorrow" or
 * "Tue 24". Plain Java (java.time only), so the test suite runs it on the JDK. Widget copy is
 * English, like every other widget string.
 */
final class DaySelection {
    /** The next arrow stops at today + 6 (the snapshot's eighth day only covers the midnight rollover). */
    static final int MAX_DAY_OFFSET = 6;
    /** "Tue 24": the day label beyond Tomorrow. */
    private static final DateTimeFormatter SHORT_DAY = DateTimeFormatter.ofPattern("EEE d", Locale.ENGLISH);
    private static final String TODAY = "Today";
    private static final String TOMORROW = "Tomorrow";

    private DaySelection() {
    }

    /**
     * The selected day offset, clamped to [0, MAX_DAY_OFFSET]. A choice saved on another local
     * date than `todayKey` has expired, so the widget is back on today after midnight.
     */
    static int selectedOffset(String savedOn, int savedOffset, String todayKey) {
        if (savedOn == null || !savedOn.equals(todayKey)) return 0;
        return clampOffset(savedOffset);
    }

    /** `offset` kept within what the arrows reach: [0, MAX_DAY_OFFSET]. */
    static int clampOffset(int offset) {
        return Math.max(0, Math.min(offset, MAX_DAY_OFFSET));
    }

    /** The two lists a snapshot day holds; {@link #key} is its name in the snapshot JSON. */
    enum View {
        /** The current date: the Focus Task first, then the queue. */
        TODAY("today"),
        /** A later day: what is planned for it. */
        FUTURE("future");

        final String key;

        View(String key) {
            this.key = key;
        }
    }

    /** The snapshot list to draw for `dateKey`: its today view only on the current date. */
    static View viewFor(String dateKey, String todayKey) {
        return dateKey.equals(todayKey) ? View.TODAY : View.FUTURE;
    }

    /** "Tue 24". */
    static String shortDayLabel(LocalDate day) {
        return SHORT_DAY.format(day);
    }

    /** The header: "Today", "Tomorrow", then "Tue 24". */
    static String headerLabel(int offset, LocalDate day) {
        return offset == 0 ? TODAY : offset == 1 ? TOMORROW : shortDayLabel(day);
    }

    /** The day inside a sentence ("Nothing left for today"): relative names in lower case, dates as drawn. */
    static String inSentence(int offset, LocalDate day) {
        return offset <= 1 ? headerLabel(offset, day).toLowerCase(Locale.ENGLISH) : shortDayLabel(day);
    }
}
