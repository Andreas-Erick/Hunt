package com.hunt.companion;

import java.util.Locale;

/**
 * The Stats Widget's size rule and number formats, kept free of Android types so the tests run
 * it on the JDK (androidStatsWidget.test.ts). Holds no Hunt rule: the numbers it formats come
 * from the Widget Snapshot.
 *
 * Row heights mirror widget_stats_*.xml in dp; keep them in step with the layouts.
 */
final class StatsWidgetFit {
    /** Fixed rows in the layouts (StatsWidgetProvider's id arrays have these lengths). */
    static final int MAX_QUEST_ROWS = 3;
    static final int MAX_STREAK_ROWS = 8;
    /** The met-target glyph (U+2713), as a code point so the source stays ASCII. */
    private static final char CHECK_MARK = (char) 0x2713;

    private static final int PADDING_DP = 16;
    private static final int HEADER_DP = 36;
    private static final int QUEST_ROW_DP = 24;
    private static final int QUESTS_MORE_DP = 18;
    private static final int STREAKS_HEADER_DP = 24;
    private static final int STREAK_ROW_DP = 20;

    /** Quest rows shown, Quests behind "+N more", streak rows shown, streaks behind "+N more". */
    int questRows;
    int questsMore;
    int streakRows;
    int streaksMore;

    private StatsWidgetFit() {
    }

    /**
     * Rows that fit a widget `heightDp` tall: Quest rows first (at least one, with a "+N more"
     * line for the rest), then streak rows under their label, whose right end carries the
     * streaks' "+N more". With no Quests, the "Set up a Quest in Hunt" line takes one row.
     */
    static StatsWidgetFit fit(int heightDp, int quests, int streaks) {
        StatsWidgetFit fit = new StatsWidgetFit();
        int left = heightDp - PADDING_DP - HEADER_DP;
        int streaksHeader = streaks > 0 ? STREAKS_HEADER_DP : 0;
        if (quests <= 0) {
            left -= QUEST_ROW_DP;
        } else {
            int rows = (left - streaksHeader) / QUEST_ROW_DP;
            if (rows < quests) rows = (left - streaksHeader - QUESTS_MORE_DP) / QUEST_ROW_DP;
            fit.questRows = Math.max(1, Math.min(Math.min(quests, MAX_QUEST_ROWS), rows));
            fit.questsMore = quests - fit.questRows;
            left -= fit.questRows * QUEST_ROW_DP + (fit.questsMore > 0 ? QUESTS_MORE_DP : 0);
        }
        left -= streaksHeader;
        int streakRows = Math.min(Math.min(Math.max(0, streaks), MAX_STREAK_ROWS), left / STREAK_ROW_DP);
        fit.streakRows = Math.max(0, streakRows);
        fit.streaksMore = Math.max(0, streaks) - fit.streakRows;
        return fit;
    }

    /** "2h 05m" or "45m" (fixed-width minutes for the tabular figures). */
    static String formatFocus(long seconds) {
        long minutes = Math.max(0, seconds) / 60;
        long h = minutes / 60;
        long m = minutes % 60;
        return h > 0 ? String.format(Locale.ROOT, "%dh %02dm", h, m) : m + "m";
    }

    /** "5.5 / 8h", "10.0 / 6h" plus a check mark for a met target, or "1.5h" without a target. */
    static String formatHours(long weekSeconds, double targetHours, boolean met) {
        String hours = String.format(Locale.ROOT, "%.1f", Math.max(0, weekSeconds) / 3600.0);
        if (!(targetHours > 0)) return hours + "h";
        String target = targetHours == Math.rint(targetHours)
                ? String.valueOf((long) targetHours)
                : String.format(Locale.ROOT, "%.1f", targetHours);
        return hours + " / " + target + "h" + (met ? " " + CHECK_MARK : "");
    }
}
