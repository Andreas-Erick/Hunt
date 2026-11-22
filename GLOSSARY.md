# Hunt

A local-first focus timer, daily habits and weekly quests for
one person, on a Windows desktop and an Android phone.

## Surfaces

**Widget**:
A glanceable view of Hunt placed on the Android home screen,
outside the app.
_Avoid_: tile, card (cards are in-app)

**Day Widget**:
The Widget that lists the Tasks of one day.
_Avoid_: today widget, task widget

**Stats Widget**:
A separate Widget, added only if the user chooses, that shows
statistics.
_Avoid_: review widget

**Pending Tick**:
A task marked done from a Widget that Hunt has not applied
yet.
_Avoid_: offline completion, queued done

**Widget Snapshot**:
The ready-to-draw data Hunt hands to the Widgets after every
save. Widgets only draw it.
_Avoid_: widget state, widget cache
