package com.hunt.companion;

/**
 * What the page's "Allow" for reminders does next (ADR-0007). Reminders need two grants: posting
 * notifications (a runtime dialog from Android 13) and exact alarms (a settings switch from
 * Android 12). One step at a time; the page asks again on resume and offers the next.
 * Plain Java, so it runs in the JDK probes; MainActivity carries each step out.
 */
final class ReminderPermissions {
    /** Android 13: POST_NOTIFICATIONS becomes a runtime permission. */
    static final int SDK_RUNTIME_NOTIFICATIONS = 33;

    enum Step {
        /** Show Android's notification permission dialog. */
        ASK_NOTIFICATIONS,
        /** The dialog will not show again (denied for good, or none before Android 13): Hunt's notification settings. */
        OPEN_NOTIFICATION_SETTINGS,
        /** Notifications are on, exact alarms are not: the "Alarms & reminders" setting. */
        OPEN_EXACT_ALARM_SETTINGS,
        /** Everything is allowed. */
        NONE
    }

    private ReminderPermissions() {
    }

    /**
     * @param notifications notifications can be posted now (granted and switched on)
     * @param asked Hunt has shown the notification dialog before
     * @param rationale Android would show the dialog again (shouldShowRequestPermissionRationale)
     * @param exact exact alarms are allowed
     */
    static Step nextStep(int sdk, boolean notifications, boolean asked, boolean rationale, boolean exact) {
        if (!notifications) {
            boolean dialogWorks = sdk >= SDK_RUNTIME_NOTIFICATIONS && (!asked || rationale);
            return dialogWorks ? Step.ASK_NOTIFICATIONS : Step.OPEN_NOTIFICATION_SETTINGS;
        }
        return exact ? Step.NONE : Step.OPEN_EXACT_ALARM_SETTINGS;
    }
}
