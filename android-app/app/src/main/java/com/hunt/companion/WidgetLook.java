package com.hunt.companion;

/**
 * Colour resources for the Widgets' look (ADR-0005), keyed by the Widget Snapshot's look name.
 * Only Neon ships so far: every look draws Neon until Dawn adds its widget_dawn_* set here.
 * Holds no Hunt rule, only the token mapping that colors.xml documents.
 */
final class WidgetLook {
    private WidgetLook() {
    }

    /** Quest accent key from the snapshot -> the look's colour resource (slate for unknown keys). */
    static int questAccent(String look, String key) {
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

    /** Text colour for a met weekly target. */
    static int success(String look) {
        return R.color.widget_neon_success;
    }

    /** Body text colour (hours below target). */
    static int text(String look) {
        return R.color.widget_neon_text;
    }

    /** Layout of the Stats Widget for the look (ids are shared by every look's layout). */
    static int statsLayout(String look) {
        return R.layout.widget_stats_neon;
    }

    /** Layout of the full-widget message ("Open Hunt to get started" / "to refresh"). */
    static int messageLayout(String look) {
        return R.layout.widget_day_message_neon;
    }
}
