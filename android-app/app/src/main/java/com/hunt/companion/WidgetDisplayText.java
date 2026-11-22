package com.hunt.companion;

import android.content.Context;
import android.content.res.Resources;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.util.DisplayMetrics;
import android.util.Log;
import android.util.TypedValue;

/**
 * The widgets' display type (the Day Widget's day title, the Stats Widget's hero figure) drawn
 * into a bitmap in the app's own typefaces (res/font, per look through {@link WidgetLook}).
 *
 * A widget's TextViews cannot use them: the launcher inflates RemoteViews with a restricted
 * package context, and TextView ignores android:fontFamily="@font/..." there
 * (Context.canLoadUnsafeResources), so body text stays in the system sans. The bitmap is exactly
 * as tall as its ImageView and the text is centred on its cap height, so a fitStart ImageView
 * only ever scales it down (a narrow widget), never up. Holds no Hunt rule.
 */
final class WidgetDisplayText {
    private static final String TAG = "HuntWidgetText";
    /** Gap between two runs ("2h 05m" and "today"), as in the app's hero pill. */
    private static final float RUN_GAP_DP = 6f;

    /** One run of text in one face. {@code font} is an R.font id, or 0 for the system sans. */
    static final class Run {
        final String text;
        final int font;
        final float sizeSp;
        final int color;
        final float letterSpacingEm;
        final boolean tabular;

        Run(String text, int font, float sizeSp, int color, float letterSpacingEm, boolean tabular) {
            this.text = text == null ? "" : text;
            this.font = font;
            this.sizeSp = sizeSp;
            this.color = color;
            this.letterSpacingEm = letterSpacingEm;
            this.tabular = tabular;
        }
    }

    private WidgetDisplayText() {
    }

    /** The Day Widget's day title ("Today", "Tue 24"), 48dp tall for the header's ImageView. */
    static Bitmap dayTitle(Context ctx, WidgetLook look, String label) {
        return render(ctx, 48, new Run(label, look.titleFont, look.titleSp, ctx.getColor(look.text),
                look.titleTracking, false));
    }

    /** The Stats Widget's hero: today's focus time in big tabular figures, then "today". */
    static Bitmap hero(Context ctx, WidgetLook look, String figure, String label) {
        return render(ctx, 40,
                new Run(figure, look.figureFont, 28f, ctx.getColor(look.text), -0.02f, true),
                new Run(label, look.labelFont, 12f, ctx.getColor(look.muted), 0f, false));
    }

    /** Draws the runs left to right on one baseline, centred on the first run's cap height. */
    static Bitmap render(Context ctx, int heightDp, Run... runs) {
        Resources res = ctx.getResources();
        DisplayMetrics dm = res.getDisplayMetrics();
        Paint[] paints = new Paint[runs.length];
        float width = 0f;
        float gap = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, RUN_GAP_DP, dm);
        for (int i = 0; i < runs.length; i++) {
            Paint p = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.SUBPIXEL_TEXT_FLAG);
            p.setTypeface(typeface(ctx, runs[i].font));
            p.setTextSize(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, runs[i].sizeSp, dm));
            p.setColor(runs[i].color);
            p.setLetterSpacing(runs[i].letterSpacingEm);
            if (runs[i].tabular) p.setFontFeatureSettings("tnum");
            paints[i] = p;
            width += p.measureText(runs[i].text) + (i > 0 ? gap : 0f);
        }
        int h = Math.max(1, Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, heightDp, dm)));
        int w = Math.max(1, (int) Math.ceil(width) + 2);
        Rect cap = new Rect();
        paints[0].getTextBounds("H", 0, 1, cap);
        float baseline = (h + cap.height()) / 2f;

        Bitmap bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        bitmap.setDensity(dm.densityDpi);
        Canvas canvas = new Canvas(bitmap);
        float x = 0f;
        for (int i = 0; i < runs.length; i++) {
            if (i > 0) x += gap;
            canvas.drawText(runs[i].text, x, baseline, paints[i]);
            x += paints[i].measureText(runs[i].text);
        }
        return bitmap;
    }

    private static Typeface typeface(Context ctx, int font) {
        if (font == 0) return Typeface.create("sans-serif", Typeface.NORMAL);
        try {
            return ctx.getResources().getFont(font);
        } catch (Resources.NotFoundException e) {
            Log.w(TAG, "widget font missing, using the system sans", e);
            return Typeface.DEFAULT_BOLD;
        }
    }
}
