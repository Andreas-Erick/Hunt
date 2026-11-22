package com.hunt.companion;

/**
 * The Widgets' look (ADR-0005) with its layouts and colour resources, picked by the Widget
 * Snapshot's look name ({@link #of}): "dawn" draws Dawn, anything else (including a missing name)
 * draws Neon, the original look. Every look has the same layouts with the same view ids, so
 * callers only pick through here and never name a look's resource themselves. Holds no Hunt rule,
 * only the token mapping that colors.xml documents.
 */
enum WidgetLook {
    NEON(R.layout.widget_day_neon, R.layout.widget_day_row_neon, R.layout.widget_day_row_undo_neon,
            R.layout.widget_day_message_neon, R.layout.widget_stats_neon,
            R.color.widget_neon_text, R.color.widget_neon_dim, R.color.widget_neon_success,
            R.color.widget_neon_accent, R.color.widget_neon_muted,
            R.drawable.widget_row_neon, R.drawable.widget_row_focus_neon,
            R.drawable.widget_tag_neon, R.drawable.widget_tag_focus_neon,
            // Space Grotesk for the day title and figures; the label beside a figure in the system
            // sans (the app's Inter, which a widget cannot load: see WidgetDisplayText).
            R.font.space_grotesk_bold, 20f, -0.01f, R.font.space_grotesk_bold, 0,
            new int[] {
                R.color.widget_neon_q_cyan, R.color.widget_neon_q_emerald, R.color.widget_neon_q_amber,
                R.color.widget_neon_q_purple, R.color.widget_neon_q_rose, R.color.widget_neon_q_sky,
                R.color.widget_neon_q_orange, R.color.widget_neon_q_lime, R.color.widget_neon_q_slate}),
    DAWN(R.layout.widget_day_dawn, R.layout.widget_day_row_dawn, R.layout.widget_day_row_undo_dawn,
            R.layout.widget_day_message_dawn, R.layout.widget_stats_dawn,
            R.color.widget_dawn_text, R.color.widget_dawn_dim, R.color.widget_dawn_success,
            R.color.widget_dawn_accent, R.color.widget_dawn_muted,
            R.drawable.widget_row_dawn, R.drawable.widget_row_focus_dawn,
            R.drawable.widget_tag_dawn, R.drawable.widget_tag_focus_dawn,
            // Newsreader for the day title (the app's Dawn headings), Hanken Grotesk for figures and labels.
            R.font.newsreader_medium, 22f, 0f, R.font.hanken_grotesk_bold, R.font.hanken_grotesk_regular,
            new int[] {
                R.color.widget_dawn_q_cyan, R.color.widget_dawn_q_emerald, R.color.widget_dawn_q_amber,
                R.color.widget_dawn_q_purple, R.color.widget_dawn_q_rose, R.color.widget_dawn_q_sky,
                R.color.widget_dawn_q_orange, R.color.widget_dawn_q_lime, R.color.widget_dawn_q_slate});

    /** The snapshot's Quest accent keys, in the order of each look's accent colours; the last is the fallback. */
    private static final String[] ACCENT_KEYS = {"cyan", "emerald", "amber", "purple", "rose", "sky", "orange", "lime", "slate"};

    /** The Day Widget (header, list and its empty view). */
    final int dayLayout;
    /** One Day Widget row. */
    final int dayRowLayout;
    /** A Day Widget row in its Undo window (Done mark, "Done · title", Undo), same height as a row. */
    final int dayUndoRowLayout;
    /** The full-widget message ("Open Hunt to get started" / "to refresh"), both widgets. */
    final int messageLayout;
    /** The Stats Widget. */
    final int statsLayout;
    /** Body text colour (an enabled arrow, hours below target). */
    final int text;
    /** Dimmed text colour (a disabled arrow). */
    final int dim;
    /** Text colour for a met weekly target. */
    final int success;
    /** The look's accent (the Focus Task's tag). */
    final int accent;
    /** Secondary label colour (any other row tag). */
    final int muted;
    /** A Day Widget row's card, and the Focus Task's card with the accent edge. */
    final int rowBackground;
    final int focusRowBackground;
    /** A row tag's pill, and the Focus tag's pill with the accent edge. */
    final int tagBackground;
    final int focusTagBackground;
    /** Display type drawn by WidgetDisplayText: the day title's face, size (sp) and tracking (em). */
    final int titleFont;
    final float titleSp;
    final float titleTracking;
    /** The Stats hero's figure face, and the face of the label beside it (0: the system sans). */
    final int figureFont;
    final int labelFont;
    private final int[] accents;

    WidgetLook(int dayLayout, int dayRowLayout, int dayUndoRowLayout, int messageLayout, int statsLayout,
            int text, int dim, int success, int accent, int muted,
            int rowBackground, int focusRowBackground, int tagBackground, int focusTagBackground,
            int titleFont, float titleSp, float titleTracking, int figureFont, int labelFont, int[] accents) {
        this.titleFont = titleFont;
        this.titleSp = titleSp;
        this.titleTracking = titleTracking;
        this.figureFont = figureFont;
        this.labelFont = labelFont;
        this.dayLayout = dayLayout;
        this.dayRowLayout = dayRowLayout;
        this.dayUndoRowLayout = dayUndoRowLayout;
        this.messageLayout = messageLayout;
        this.statsLayout = statsLayout;
        this.text = text;
        this.dim = dim;
        this.success = success;
        this.accent = accent;
        this.muted = muted;
        this.rowBackground = rowBackground;
        this.focusRowBackground = focusRowBackground;
        this.tagBackground = tagBackground;
        this.focusTagBackground = focusTagBackground;
        this.accents = accents;
    }

    /** The look a snapshot names: Dawn only for exactly "dawn". */
    static WidgetLook of(String name) {
        return "dawn".equals(name) ? DAWN : NEON;
    }

    /** Quest accent key from the snapshot -> this look's colour resource (slate for unknown keys). */
    int questAccent(String key) {
        for (int i = 0; i < ACCENT_KEYS.length; i++) {
            if (ACCENT_KEYS[i].equals(key)) return accents[i];
        }
        return accents[accents.length - 1];
    }
}
