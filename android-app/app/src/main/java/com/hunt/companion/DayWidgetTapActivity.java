package com.hunt.companion;

import android.app.Activity;
import android.os.Bundle;
import android.util.Log;

/**
 * No-UI trampoline for Day Widget row taps (tick, Undo, open Hunt). The list's PendingIntent
 * template targets this activity rather than a broadcast, because opening Hunt from a broadcast
 * receiver is a background activity launch: blocked from Android 10 unless an exemption applies,
 * and from Android 14 the launcher no longer lends its own exemption to a PendingIntent it sends
 * unless it opts in. A widget tap that starts an activity is a launch the user started from the
 * launcher, and this activity, now in the foreground, may then start MainActivity.
 *
 * Not exported (only the widget's own PendingIntent reaches it), Theme.NoDisplay (it draws
 * nothing and finishes in onCreate, before onResume, as that theme requires), no history, kept
 * out of Recents and in its own empty-affinity task so it never joins Hunt's task. It holds no
 * logic: DayWidgetProvider decides.
 */
public class DayWidgetTapActivity extends Activity {
    private static final String TAG = "HuntDayWidgetTap";

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        // A recreated instance (state != null) already handled its tap.
        if (state == null) {
            try {
                if (DayWidgetProvider.onRowTap(this, getIntent())) {
                    startActivity(DayWidgetProvider.launchIntent(this));
                }
            } catch (RuntimeException e) {
                Log.w(TAG, "Day Widget row tap failed", e);
            }
        }
        finish();
        overridePendingTransition(0, 0);
    }
}
