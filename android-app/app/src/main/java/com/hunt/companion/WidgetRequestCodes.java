package com.hunt.companion;

/**
 * Every PendingIntent request code the widgets use, in one place. NEVER change a value: a placed
 * widget and an armed alarm hold PendingIntents by (component, action, data, request code), so a
 * new code after an APK update leaves the old intent behind (a stale tap target, an alarm that
 * can no longer be cancelled). Codes only need to differ where those other parts are the same.
 */
final class WidgetRequestCodes {
    private WidgetRequestCodes() {
    }

    /** Day Widget: header and message taps that open Hunt (activity). */
    static final int DAY_OPEN_HUNT = 0;
    /** Day Widget: the list's row-tap template to the trampoline (activity). */
    static final int DAY_ROW_TEMPLATE = 1;
    /** Day Widget: the midnight redraw alarm (broadcast). */
    static final int DAY_MIDNIGHT = 0;
    /** Day Widget: the prev and next arrows (broadcast; each has its own data URI). */
    static final int DAY_NAV = 0;
    /** Day Widget: the Undo backstop alarm (broadcast). */
    static final int DAY_UNDO_DUE = 2;
    /** Stats Widget: tap to open Hunt (activity). */
    static final int STATS_OPEN_HUNT = 20;
    /** Stats Widget: the midnight redraw alarm (broadcast). */
    static final int STATS_MIDNIGHT = 21;
}
