package com.hunt.companion;

/**
 * Layouts and colour resources for the Widgets' look (ADR-0005), keyed by the Widget Snapshot's
 * look name: "dawn" draws Dawn, anything else (including a missing name) draws Neon, the
 * original look. Every look has the same layouts with the same view ids, so callers only pick
 * through here and never name a look's resource themselves. Holds no Hunt rule, only the token
 * mapping that colors.xml documents.
 */
final class WidgetLook {
    /** How many looks there are: the Day Widget's list declares one row view type per look. */
    static final int COUNT = 2;

    private WidgetLook() {
    }

    private static boolean isDawn(String look) {
        return "dawn".equals(look);
    }

    /** Layout of the Day Widget (header, list and its empty view). */
    static int dayLayout(String look) {
        return isDawn(look) ? R.layout.widget_day_dawn : R.layout.widget_day_neon;
    }

    /** Layout of one Day Widget row. */
    static int dayRowLayout(String look) {
        return isDawn(look) ? R.layout.widget_day_row_dawn : R.layout.widget_day_row_neon;
    }

    /** Layout of a Day Widget row in its Undo window ("✓ Done · Undo"), same height as a row. */
    static int dayUndoRowLayout(String look) {
        return isDawn(look) ? R.layout.widget_day_row_undo_dawn : R.layout.widget_day_row_undo_neon;
    }

    /** Layout of the full-widget message ("Open Hunt to get started" / "to refresh"). */
    static int messageLayout(String look) {
        return isDawn(look) ? R.layout.widget_day_message_dawn : R.layout.widget_day_message_neon;
    }

    /** Layout of the Stats Widget. */
    static int statsLayout(String look) {
        return isDawn(look) ? R.layout.widget_stats_dawn : R.layout.widget_stats_neon;
    }

    /** Body text colour (an enabled arrow, hours below target). */
    static int text(String look) {
        return isDawn(look) ? R.color.widget_dawn_text : R.color.widget_neon_text;
    }

    /** Dimmed text colour (a disabled arrow). */
    static int dim(String look) {
        return isDawn(look) ? R.color.widget_dawn_dim : R.color.widget_neon_dim;
    }

    /** Text colour for a met weekly target. */
    static int success(String look) {
        return isDawn(look) ? R.color.widget_dawn_success : R.color.widget_neon_success;
    }

    /** Quest accent key from the snapshot -> the look's colour resource (slate for unknown keys). */
    static int questAccent(String look, String key) {
        return isDawn(look) ? dawnAccent(key) : neonAccent(key);
    }

    private static int neonAccent(String key) {
        switch (key == null ? "" : key) {
            case "cyan": return R.color.widget_neon_q_cyan;
            case "emerald": return R.color.widget_neon_q_emerald;
            case "amber": return R.color.widget_neon_q_amber;
            case "purple": return R.color.widget_neon_q_purple;
            case "rose": return R.color.widget_neon_q_rose;
            case "sky": return R.color.widget_neon_q_sky;
            case "orange": return R.color.widget_neon_q_orange;
            case "lime": return R.color.widget_neon_q_lime;
            default: return R.color.widget_neon_q_slate;
        }
    }

    private static int dawnAccent(String key) {
        switch (key == null ? "" : key) {
            case "cyan": return R.color.widget_dawn_q_cyan;
            case "emerald": return R.color.widget_dawn_q_emerald;
            case "amber": return R.color.widget_dawn_q_amber;
            case "purple": return R.color.widget_dawn_q_purple;
            case "rose": return R.color.widget_dawn_q_rose;
            case "sky": return R.color.widget_dawn_q_sky;
            case "orange": return R.color.widget_dawn_q_orange;
            case "lime": return R.color.widget_dawn_q_lime;
            default: return R.color.widget_dawn_q_slate;
        }
    }
}
