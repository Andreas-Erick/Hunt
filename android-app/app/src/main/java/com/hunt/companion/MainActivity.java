package com.hunt.companion;

import android.app.Activity;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Rect;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.system.ErrnoException;
import android.system.OsConstants;
import android.util.AtomicFile;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsAnimation;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.MalformedURLException;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.Key;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Pattern;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Hunt companion: a full-screen WebView around {@code assets/hunt-mobile.html} plus the
 * {@code window.AndroidBridge} JavaScript interface.
 *
 * <p>The app is offline-first: it must feel exactly the same whether or not the laptop is
 * reachable. Threading model:
 * <ul>
 *   <li><b>UI thread</b>: lifecycle, every WebView call (evaluateJavascript is only ever called
 *       here), window flags, haptics, network-callback bookkeeping.</li>
 *   <li><b>JavaBridge thread</b> (owned by WebView): every {@code @JavascriptInterface} method.
 *       The renderer's JS thread waits synchronously for these, so they only touch memory and
 *       hand work off; each returns within a few ms. The only exception is a one-time lazy
 *       read of a small file, which is cached afterwards (and normally pre-warmed).</li>
 *   <li><b>ioExec</b> (single thread, FIFO): every file write. State writes coalesce to the
 *       newest JSON and go through {@link AtomicFile} (fsync + rename).</li>
 *   <li><b>netExec</b> (single thread): laptop sync. The result is delivered back to JS via
 *       {@code window.__huntSyncDone(result)}.</li>
 *   <li><b>watchdog</b> (single-thread scheduler): hard deadlines for sync attempts and rounds.
 *       Its tasks only close sockets and hand results to the UI thread.</li>
 *   <li><b>dnsExec</b> (a few threads at most): hostname lookups with a bounded wait.</li>
 * </ul>
 *
 * <p>JS is the only writer of the state file: native never persists a sync response itself
 * (JS merges it into its current state and calls saveState).
 *
 * <p>Data compatibility: the file names below and the state/URL plain-text formats are the ones
 * the previous version wrote. AtomicFile reads such legacy plain files as-is. The sync token file
 * now holds an AndroidKeyStore-encrypted envelope; a legacy plain-text token is used once and
 * rewritten encrypted.
 *
 * <p>Isolation: the WebView may only show {@link #PAGE_URL} and only load assets, data:/blob:
 * URLs and Google Fonts, so no other document ever runs next to {@code AndroidBridge}.
 */
public class MainActivity extends Activity {

    private static final String TAG = "Hunt";
    private static final String WEB_TAG = "HuntWeb";
    private static final String BRIDGE_NAME = "AndroidBridge";
    private static final String PAGE_URL = "file:///android_asset/hunt-mobile.html";

    // Legacy file names in filesDir: never change them (user data compatibility).
    private static final String STATE_FILE = "hunt-mobile-state.json";
    private static final String LAPTOP_URL_FILE = "hunt-laptop-url.txt";
    private static final String SYNC_TOKEN_FILE = "hunt-sync-token.txt";

    private static final String DEFAULT_LAPTOP_URL = "http://192.168.2.136:3000";

    /** Header-safe pairing token: 32-256 printable ASCII characters, no spaces (same rule as the server). */
    private static final Pattern SYNC_TOKEN_RE = Pattern.compile("^[\\x21-\\x7E]{32,256}$");
    /** Token file format: "v2:" + Base64(iv) + ":" + Base64(AES-GCM ciphertext + tag). */
    private static final String TOKEN_ENVELOPE_PREFIX = "v2:";
    private static final String KEYSTORE_PROVIDER = "AndroidKeyStore";
    private static final String TOKEN_KEY_ALIAS = "hunt-sync-token-key";
    private static final String TOKEN_CIPHER = "AES/GCM/NoPadding";
    private static final int TOKEN_KEY_BITS = 256;
    private static final int GCM_TAG_BITS = 128;

    // What the page may load (see HuntWebViewClient). Compared against WebView's canonical URLs.
    private static final String ASSET_URL_PREFIX = "file:///android_asset/";
    private static final String[] FONT_URL_PREFIXES = {
            "https://fonts.googleapis.com/", "https://fonts.gstatic.com/"};

    // Sync tuning. Timeouts no longer affect the UI (sync runs on netExec), they only decide
    // how quickly a dead route is given up.
    private static final int MAX_CANDIDATES = 6;
    private static final int CONNECT_TIMEOUT_LAN_MS = 1500;    // RFC1918 hosts
    private static final int CONNECT_TIMEOUT_OTHER_MS = 2500;  // Tailscale / hostnames / other
    private static final int READ_TIMEOUT_MS = 10000;          // lets a cold `next dev` compile finish
    /** Whole-sync budget, kept well below the 45 s JS watchdog so a result always arrives first. */
    private static final long SYNC_BUDGET_MS = 35000;
    private static final long MIN_ATTEMPT_MS = 1000;
    /**
     * Hard per-attempt deadline slack: an attempt is cut off (its socket closed) at
     * min(connect start + connect timeout + read timeout, round start + budget) + this.
     * Android's HttpURLConnection has no write timeout, so a stalled body upload needs it.
     */
    private static final long ATTEMPT_KILL_SLACK_MS = 3000;
    /**
     * If the sync thread is still busy this long after the last possible attempt deadline, the
     * round is abandoned: JS gets a failure, busy is released and later rounds use a fresh thread.
     * Round start + 35 s + 3 s + 2 s = 40 s, still before the 45 s JS watchdog.
     */
    private static final long ROUND_ABANDON_GRACE_MS = 2000;
    /** Upper bound for the raw-socket probe that classifies an errno-less ConnectException. */
    private static final long PROBE_TIMEOUT_MAX_MS = 1500;
    /** Lookups that hang keep their thread (getaddrinfo cannot be interrupted); at most this many. */
    private static final int DNS_THREADS = 4;
    private static final int MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
    private static final int MAX_ERROR_DRAIN_BYTES = 64 * 1024;

    private static final long STOP_FLUSH_WAIT_MS = 500;
    /** Back fallback if the page does not answer (renderer hung or gone). */
    private static final long BACK_FALLBACK_MS = 750;
    /** A second renderer loss within this window finishes instead of recreating (no crash loop). */
    private static final long RENDERER_RESTART_WINDOW_MS = 10000;

    private static final String BACK_SCRIPT =
            "(window.__huntBack&&window.__huntBack())?'handled':'unhandled'";
    private static final String BACK_HANDLED = "\"handled\"";

    // ---------------------------------------------------------------------------------------
    // Process-wide persistence state. Static on purpose: when the Activity is recreated
    // (renderer loss, an unhandled config change) the new page's loadState() must see the
    // newest state from memory instead of reading a file that may still be being written.
    // ---------------------------------------------------------------------------------------

    /** Guards every file read/write (state, URL and token files). */
    private static final Object FILE_LOCK = new Object();
    /** Guards the compare-and-set of {@link #latestState} after the one-time disk read. */
    private static final Object LATEST_LOCK = new Object();
    /** Guards the one-time lazy load of the URL cache. */
    private static final Object CONFIG_LOCK = new Object();
    /**
     * Guards the one-time lazy load (and decryption) of the token cache. Separate from
     * CONFIG_LOCK so Keystore work never makes a JavaBridge call wait.
     */
    private static final Object TOKEN_LOCK = new Object();

    /** Newest state JSON known to this process (from JS or the one-time disk read). Never cleared. */
    private static volatile String latestState;
    /** Newest state JSON not yet handed to a write. Writers take it with getAndSet(null). */
    private static final AtomicReference<String> pendingState = new AtomicReference<>();
    /** What the state file currently holds, to skip identical rewrites. Guarded by FILE_LOCK. */
    private static String lastWrittenState;

    /** Normalized laptop URL as saved ("" = nothing saved, null = not loaded yet). */
    private static volatile String laptopUrlCache;
    /**
     * Valid sync token in plain text, memory only ("" = not paired, null = not loaded yet).
     * The JavaBridge thread only ever sets it; loading/decrypting runs on ioExec / netExec.
     */
    private static final AtomicReference<String> syncTokenCache = new AtomicReference<>();

    /** UI thread only: elapsedRealtime of the last renderer loss. */
    private static long lastRendererGoneAt;

    // ---------------------------------------------------------------------------------------
    // Per-Activity state
    // ---------------------------------------------------------------------------------------

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService ioExec = Executors.newSingleThreadExecutor(namedThreads("hunt-io"));
    /** Laptop sync, one round at a time. Replaced only when a stuck round is abandoned. */
    private volatile ExecutorService netExec = newNetExec();
    /** Hard deadlines for sync attempts and rounds (see ATTEMPT_KILL_SLACK_MS). */
    private final ScheduledThreadPoolExecutor watchdog = newWatchdog();
    /** Hostname lookups with a bounded wait (the lookup inside connect() has no timeout). */
    private final ExecutorService dnsExec = new ThreadPoolExecutor(0, DNS_THREADS, 30, TimeUnit.SECONDS,
            new SynchronousQueue<Runnable>(), namedThreads("hunt-dns"));
    /** True while a sync runs on netExec (one at a time; JS is told "busy" otherwise). */
    private final AtomicBoolean syncBusy = new AtomicBoolean(false);
    /** The round running now (null when idle); onDestroy closes its connection. */
    private final AtomicReference<SyncRound> activeRound = new AtomicReference<>();
    /** Set on the UI thread in onDestroy; checked before any JS delivery. */
    private volatile boolean destroyed;

    // Written once in onCreate, read from the bridge / executor threads.
    private volatile File filesDir;
    private volatile ConnectivityManager connectivity;
    private volatile String appVersion = "";

    // UI thread only.
    private WebView webView;
    private ConnectivityManager.NetworkCallback networkCallback;
    private Network lastNetwork;
    private boolean lastOnline;
    private Boolean keepScreenOnApplied;
    private boolean backPending;
    private int backSeq;
    private int lastImeDp = -1;
    private int imeAnimationDepth = 0;
    private boolean containerPaddingInitialized = false;

    // =======================================================================================
    // Lifecycle
    // =======================================================================================

    @Override
    @SuppressWarnings("deprecation") // setStatusBarColor/setNavigationBarColor: fine at targetSdk 34
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        filesDir = getFilesDir();
        connectivity = getSystemService(ConnectivityManager.class);
        appVersion = readAppVersion();

        // Pre-warm the caches so the page's first loadState()/getLaptopUrl() are memory reads.
        executeQuietly(ioExec, this::warmCaches);

        Window window = getWindow();
        if (window != null) {
            window.setStatusBarColor(Color.parseColor("#0B0C0E"));
            window.setNavigationBarColor(Color.parseColor("#0E1015"));
        }

        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        webView = new WebView(this) {
            @Override
            public void getFocusedRect(Rect r) {
                // Report (0,0)-(0,0) at the top of WebView so ViewRootImpl.scrollToRectOrFocus
                // never pans DecorView up and back down when an HTML input near the bottom focuses.
                if (r != null) r.set(0, 0, 0, 0);
            }

            @Override
            public boolean requestRectangleOnScreen(Rect rectangle, boolean immediate) {
                return false;
            }
        };
        webView.setBackgroundColor(Color.parseColor("#0B0C0E"));
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);

        // Wrap WebView in a FrameLayout: Android's WebView ignores View.setPadding() for its
        // Chromium viewport surface, whereas FrameLayout padding constrains the WebView bounds
        // strictly inside the status bar, Samsung bottom/side navigation bar, and display cutout.
        FrameLayout container = new FrameLayout(this) {
            @Override
            public boolean requestChildRectangleOnScreen(View child, Rect rectangle, boolean immediate) {
                return false;
            }
        };
        container.setBackgroundColor(Color.parseColor("#0B0C0E"));
        container.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && window != null) {
            // Android 11+: SOFT_INPUT_ADJUST_NOTHING + setDecorFitsSystemWindows(false) prevents
            // WindowManager, ViewRootImpl, and Chromium AwContents from ever resizing or panning
            // the WebView surface when the keyboard opens or closes.
            window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING);
            window.setDecorFitsSystemWindows(false);
            webView.setFitsSystemWindows(false);
            installSmoothImeInsets(container);
        } else {
            webView.setFitsSystemWindows(true);
        }

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true); // localStorage, origin file:// (PAGE_URL never moves)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // Explicit capability token (immune to Chromium User-Agent Reduction "Android 10; K")
            // so hunt-mobile.html locks interactive-widget=overlays-content before first paint.
            String ua = settings.getUserAgentString();
            if (ua != null && !ua.contains("HuntSmoothIme/1")) {
                settings.setUserAgentString(ua + " HuntSmoothIme/1");
            }
        }
        // Least privilege: file:///android_asset stays readable regardless of these, and sync
        // runs natively, so the page needs no file:// / content:// access and no mixed content.
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        webView.setWebViewClient(new HuntWebViewClient());
        webView.setWebChromeClient(new HuntChromeClient());
        webView.addJavascriptInterface(new AndroidNativeBridge(), BRIDGE_NAME);
        setContentView(container);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && window != null) {
            WindowInsetsController controller = window.getInsetsController();
            if (controller != null) {
                // Dark background: keep status bar and navigation bar icons light/high-contrast.
                controller.setSystemBarsAppearance(0,
                        WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                                | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
            }
            container.requestApplyInsets();
        }

        registerNetworkCallback();

        webView.loadUrl(PAGE_URL);
    }

    private void installSmoothImeInsets(View container) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return;
        container.setOnApplyWindowInsetsListener((v, insets) -> {
            Insets bars = insets.getInsets(
                    WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsets.Type.ime());
            // Do NOT change container bottom padding while the IME is visible or animating:
            // on Samsung One UI, navigationBars().bottom jumps from ~15dp (gesture pill) to ~48dp
            // (IME switcher bar) when the keyboard opens, which would resize WebView and shift the
            // whole app up and down! Lock bottom padding to its resting (IME-closed) height.
            int bottomPad = (!containerPaddingInitialized || (ime.bottom == 0 && imeAnimationDepth == 0))
                    ? bars.bottom
                    : v.getPaddingBottom();
            if (!containerPaddingInitialized
                    || v.getPaddingLeft() != bars.left
                    || v.getPaddingTop() != bars.top
                    || v.getPaddingRight() != bars.right
                    || v.getPaddingBottom() != bottomPad) {
                containerPaddingInitialized = true;
                v.setPadding(bars.left, bars.top, bars.right, bottomPad);
            }
            // Android dispatches onApplyWindowInsets with the END target IME height right between
            // onPrepare and onStart (before frame 1 of onProgress). Ignore it while animating so
            // --kb never jumps to 100% and back down to frame 1!
            if (imeAnimationDepth == 0) {
                pushImeInset(Math.max(0, ime.bottom - v.getPaddingBottom()));
            }
            return WindowInsets.CONSUMED;
        });
        container.setWindowInsetsAnimationCallback(
                new WindowInsetsAnimation.Callback(WindowInsetsAnimation.Callback.DISPATCH_MODE_STOP) {
                    @Override
                    public void onPrepare(WindowInsetsAnimation animation) {
                        if ((animation.getTypeMask() & WindowInsets.Type.ime()) != 0) {
                            imeAnimationDepth++;
                        }
                    }

                    @Override
                    public WindowInsets onProgress(
                            WindowInsets insets, List<WindowInsetsAnimation> runningAnimations) {
                        Insets ime = insets.getInsets(WindowInsets.Type.ime());
                        pushImeInset(Math.max(0, ime.bottom - container.getPaddingBottom()));
                        return WindowInsets.CONSUMED;
                    }

                    @Override
                    public void onEnd(WindowInsetsAnimation animation) {
                        if ((animation.getTypeMask() & WindowInsets.Type.ime()) != 0) {
                            imeAnimationDepth = Math.max(0, imeAnimationDepth - 1);
                        }
                        if (imeAnimationDepth == 0) {
                            WindowInsets root = container.getRootWindowInsets();
                            if (root != null) {
                                Insets bars = root.getInsets(
                                        WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                                Insets ime = root.getInsets(WindowInsets.Type.ime());
                                if (ime.bottom == 0 && container.getPaddingBottom() != bars.bottom) {
                                    container.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                                }
                                pushImeInset(Math.max(0, ime.bottom - container.getPaddingBottom()));
                            }
                        }
                    }
                });
    }

    private void pushImeInset(int imePx) {
        float density = getResources().getDisplayMetrics().density;
        int dp = density > 0f ? Math.max(0, Math.round(imePx / density)) : 0;
        if (dp == lastImeDp) return;
        lastImeDp = dp;
        if (webView != null && !destroyed) {
            webView.evaluateJavascript("window.__huntSetIme&&window.__huntSetIme(" + dp + ")", null);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.resumeTimers();
            webView.onResume();
        }
        // After timers run again, so the page can re-render time-dependent views and sync.
        callJs("__huntLifecycle", "\"resume\"");
    }

    @Override
    protected void onPause() {
        super.onPause();
        // Sent BEFORE pausing, so the page can flush drafts and persist right away.
        callJs("__huntLifecycle", "\"pause\"");
        if (webView != null) {
            webView.onPause();
            webView.pauseTimers(); // process-wide; always paired with resumeTimers() in onResume
        }
    }

    @Override
    protected void onStop() {
        super.onStop();
        // Make sure the newest state is on disk before the process can be frozen or killed.
        flushStateBlocking(STOP_FLUSH_WAIT_MS);
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        main.removeCallbacksAndMessages(null);
        unregisterNetworkCallback();
        destroyWebView();
        abortActiveSync();     // closes an in-flight request's socket (on the watchdog thread)
        netExec.shutdownNow(); // an in-flight sync result is dropped (destroyed)
        watchdog.shutdown();   // deadlines already scheduled still fire, so no attempt outlives them
        dnsExec.shutdownNow();
        ioExec.shutdown();     // queued writes still complete
        super.onDestroy();
    }

    /** Detaches and destroys the WebView (UI thread). Safe to call more than once. */
    private void destroyWebView() {
        WebView wv = webView;
        webView = null;
        if (wv == null) return;
        try {
            wv.removeJavascriptInterface(BRIDGE_NAME);
            ViewParent parent = wv.getParent();
            if (parent instanceof ViewGroup) ((ViewGroup) parent).removeView(wv);
            wv.stopLoading();
        } catch (RuntimeException e) {
            Log.w(TAG, "WebView detach failed", e);
        }
        wv.destroy();
    }

    // =======================================================================================
    // Back handling
    // =======================================================================================

    /**
     * Back asks the page first (close a sheet / return to Today). If the page does not handle it,
     * the task moves to the background instead of finishing, so the app stays warm.
     *
     * <p>targetSdk is 34 and the manifest sets enableOnBackInvokedCallback="false", so the system
     * keeps dispatching this legacy callback on every Android version (incl. 16/17), and no
     * OnBackInvokedCallback is registered that could take precedence.
     */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        final WebView wv = webView;
        if (wv == null || destroyed) {
            leaveToBackground();
            return;
        }
        if (backPending) return; // ignore re-entrant presses while the page is answering
        backPending = true;
        final int seq = ++backSeq;

        // If the renderer is hung or gone the callback may never come: don't trap the user.
        final Runnable fallback = () -> {
            if (backPending && seq == backSeq) {
                backPending = false;
                leaveToBackground();
            }
        };
        main.postDelayed(fallback, BACK_FALLBACK_MS);

        try {
            wv.evaluateJavascript(BACK_SCRIPT, value -> {
                if (!backPending || seq != backSeq) return; // the fallback already handled this press
                backPending = false;
                main.removeCallbacks(fallback);
                if (!BACK_HANDLED.equals(value)) leaveToBackground();
            });
        } catch (RuntimeException e) {
            backPending = false;
            main.removeCallbacks(fallback);
            leaveToBackground();
        }
    }

    @SuppressWarnings("deprecation")
    private void leaveToBackground() {
        if (destroyed || isFinishing()) return;
        if (!moveTaskToBack(true)) super.onBackPressed();
    }

    // =======================================================================================
    // WebView clients
    // =======================================================================================

    /**
     * Navigation and request allowlist: the bridge-enabled WebView only ever shows PAGE_URL and
     * only loads what that page needs (see {@link #isAllowedRequest}). Sync does not go through
     * the WebView (syncWithLaptopAsync is native), so the laptop is not on the list.
     */
    private final class HuntWebViewClient extends WebViewClient {
        /** Page-initiated navigations (links, location changes, frames): only PAGE_URL itself. */
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request == null ? null : request.getUrl();
            if (uri != null && isPageUrl(uri.toString())) return false;
            Log.w(TAG, "Blocked navigation to " + originForLog(uri));
            return true; // cancelled, and never handed to another app
        }

        /** Every subresource and frame load (background thread): allowlisted, else an empty 403. */
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request == null ? null : request.getUrl();
            if (uri != null && isAllowedRequest(uri.toString())) return null; // load normally
            Log.w(TAG, "Blocked request to " + originForLog(uri));
            return new WebResourceResponse("text/plain", "utf-8", 403, "Blocked",
                    Collections.<String, String>emptyMap(), new ByteArrayInputStream(new byte[0]));
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            boolean crashed = detail != null && detail.didCrash();
            Log.w(TAG, "WebView renderer " + (crashed ? "crashed" : "was killed"));

            // The dead WebView must not be used again: remove and destroy it right away.
            if (view == webView) {
                destroyWebView();
            } else if (view != null) {
                try { view.destroy(); } catch (RuntimeException ignored) { }
            }
            if (destroyed || isFinishing()) return true;

            long now = SystemClock.elapsedRealtime();
            boolean looping = lastRendererGoneAt != 0 && now - lastRendererGoneAt < RENDERER_RESTART_WINDOW_MS;
            lastRendererGoneAt = now;
            if (looping) {
                Log.e(TAG, "Renderer lost twice within " + RENDERER_RESTART_WINDOW_MS + " ms; finishing");
                finish();
            } else {
                recreate(); // fresh WebView; loadState() is served from memory (latestState)
            }
            return true; // handled: do not kill the app process
        }
    }

    /** PAGE_URL, ignoring a #fragment (in-page anchors). Pure string check. */
    private static boolean isPageUrl(String url) {
        int hash = url.indexOf('#');
        return PAGE_URL.equals(hash >= 0 ? url.substring(0, hash) : url);
    }

    /**
     * Requests the page may make: bundled assets (no "..", so nothing outside android_asset),
     * data:/blob: URLs, about:blank and the Google Fonts hosts (exact host: the prefixes end
     * with "/"). WebView hands over canonical URLs (lower-case scheme/host, "/" path at least).
     */
    private static boolean isAllowedRequest(String url) {
        if (startsWithIgnoreCase(url, ASSET_URL_PREFIX)) return !url.contains("..");
        if (startsWithIgnoreCase(url, "data:") || startsWithIgnoreCase(url, "blob:")) return true;
        if (url.equals("about:blank")) return true;
        for (String prefix : FONT_URL_PREFIXES) {
            if (startsWithIgnoreCase(url, prefix)) return true;
        }
        return false;
    }

    private static boolean startsWithIgnoreCase(String s, String prefix) {
        return s.regionMatches(true, 0, prefix, 0, prefix.length());
    }

    /** Scheme and host only: a blocked URL's path or query is never logged. */
    private static String originForLog(Uri uri) {
        return uri == null ? "(none)" : uri.getScheme() + "://" + uri.getHost();
    }

    private static final class HuntChromeClient extends WebChromeClient {
        @Override
        public boolean onConsoleMessage(ConsoleMessage m) {
            if (m != null) {
                Log.d(WEB_TAG, m.messageLevel() + ": " + m.message()
                        + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
            }
            return true;
        }
    }

    // =======================================================================================
    // Native -> JS events
    // =======================================================================================

    /** {@code window.fn&&window.fn(arg)}: a no-op while the page (or that hook) is not there. */
    private static String jsCall(String fn, String argJs) {
        return "window." + fn + "&&window." + fn + "(" + argJs + ")";
    }

    /** Evaluates {@code window.fn&&window.fn(arg)}. UI thread only. */
    private void callJs(String fn, String argJs) {
        evalJs(jsCall(fn, argJs));
    }

    /** UI thread only. Skipped once the Activity is destroyed or the WebView is gone. */
    private void evalJs(String script) {
        if (destroyed || webView == null) return;
        try {
            webView.evaluateJavascript(script, null);
        } catch (RuntimeException e) {
            Log.w(TAG, "evaluateJavascript failed", e);
        }
    }

    /** From any thread: hops to the UI thread, then {@link #evalJs}. */
    private void postJs(final String script) {
        if (destroyed) return;
        main.post(() -> evalJs(script));
    }

    /**
     * JSON text is a valid JS expression; additionally escape U+2028/U+2029, which engines
     * older than ES2019 reject inside string literals.
     */
    private static String toJsLiteral(JSONObject o) {
        String s = o.toString();
        if (s.indexOf('\u2028') >= 0 || s.indexOf('\u2029') >= 0) {
            s = s.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");
        }
        return s;
    }

    // =======================================================================================
    // Connectivity -> window.__huntNetwork({online})
    // =======================================================================================

    private void registerNetworkCallback() {
        final ConnectivityManager cm = connectivity;
        if (cm == null) return;
        try {
            // Seed with the current state so the callback's initial onAvailable is not reported.
            lastNetwork = cm.getActiveNetwork();
            lastOnline = lastNetwork != null;
            ConnectivityManager.NetworkCallback cb = new ConnectivityManager.NetworkCallback() {
                // Called on ConnectivityManager's own thread: hop to the UI thread.
                @Override
                public void onAvailable(final Network network) {
                    main.post(() -> onDefaultNetworkAvailable(network));
                }

                @Override
                public void onLost(final Network network) {
                    main.post(() -> onDefaultNetworkLost(network));
                }
            };
            cm.registerDefaultNetworkCallback(cb);
            networkCallback = cb;
        } catch (RuntimeException e) {
            Log.w(TAG, "Network callback unavailable", e);
        }
    }

    private void unregisterNetworkCallback() {
        ConnectivityManager cm = connectivity;
        ConnectivityManager.NetworkCallback cb = networkCallback;
        networkCallback = null;
        if (cm == null || cb == null) return;
        try {
            cm.unregisterNetworkCallback(cb);
        } catch (RuntimeException ignored) {
            // not registered
        }
    }

    /**
     * A (new) default network. Reported as online:true unless it is the same network we already
     * reported (duplicate). A switch to a different network while online (Wi-Fi -> cellular,
     * VPN up) is reported again: routes changed, so an immediate sync attempt is worthwhile.
     */
    private void onDefaultNetworkAvailable(Network network) {
        if (destroyed || network == null) return;
        if (lastOnline && network.equals(lastNetwork)) return;
        lastNetwork = network;
        lastOnline = true;
        callJs("__huntNetwork", "{\"online\":true}");
    }

    /** Only the loss of the network we consider default counts (ignores stale/out-of-order losses). */
    private void onDefaultNetworkLost(Network network) {
        if (destroyed || network == null || !network.equals(lastNetwork)) return;
        lastNetwork = null;
        if (!lastOnline) return;
        lastOnline = false;
        callJs("__huntNetwork", "{\"online\":false}");
    }

    private boolean hasActiveNetwork() {
        ConnectivityManager cm = connectivity;
        if (cm == null) return true; // unknown: let the attempts decide
        try {
            return cm.getActiveNetwork() != null;
        } catch (RuntimeException e) {
            return true;
        }
    }

    /** True if any network the app can see is a VPN (Tailscale). */
    @SuppressWarnings("deprecation") // getAllNetworks(): still the simplest way at minSdk 26
    private boolean anyVpnNetwork() {
        ConnectivityManager cm = connectivity;
        if (cm == null) return true; // unknown: don't skip Tailscale candidates
        try {
            for (Network n : cm.getAllNetworks()) {
                NetworkCapabilities caps = cm.getNetworkCapabilities(n);
                if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) return true;
            }
            return false;
        } catch (RuntimeException e) {
            return true;
        }
    }

    // =======================================================================================
    // Persistence (state file + laptop URL + sync token)
    // =======================================================================================

    private File file(String name) {
        return new File(filesDir, name);
    }

    /**
     * ioExec: fills the caches before the page asks, so the bridge getters are memory reads and
     * the token's Keystore decryption is done before the first sync.
     */
    private void warmCaches() {
        loadStateInternal();
        laptopUrl();
        syncToken();
    }

    /** Newest state JSON: memory if known, else a one-time read of the state file (cached). */
    private String loadStateInternal() {
        String s = latestState;
        if (s != null) return s;
        String disk;
        synchronized (FILE_LOCK) {
            disk = readTextFile(file(STATE_FILE));
            if (lastWrittenState == null) lastWrittenState = disk;
        }
        synchronized (LATEST_LOCK) {
            if (latestState == null) latestState = disk; // a concurrent saveState wins
            return latestState;
        }
    }

    /**
     * Records the newest JSON (memory first) and schedules a coalescing write on ioExec.
     * Anything not shaped like a JSON object is ignored, so it can never replace the only copy.
     */
    private void saveStateInternal(String json) {
        if (!looksLikeJsonObject(json)) {
            Log.w(TAG, "saveState ignored: not a JSON object (" + (json == null ? "null" : json.length() + " chars") + ")");
            return;
        }
        synchronized (LATEST_LOCK) {
            latestState = json;
        }
        pendingState.set(json);
        // Always enqueue: extra flushes are cheap no-ops, and nothing can get stuck un-scheduled.
        // If ioExec is already shut down, the JSON stays pending for the next flush.
        executeQuietly(ioExec, this::flushPendingState);
    }

    /** Non-blank, and the first and last non-whitespace characters are '{' and '}'. O(whitespace). */
    private static boolean looksLikeJsonObject(String s) {
        if (s == null) return false;
        int start = 0;
        int end = s.length() - 1;
        while (start <= end && Character.isWhitespace(s.charAt(start))) start++;
        while (end > start && Character.isWhitespace(s.charAt(end))) end--;
        return start < end && s.charAt(start) == '{' && s.charAt(end) == '}';
    }

    /**
     * ioExec: writes the newest pending JSON. Taking the value inside FILE_LOCK means the write
     * that runs last always carries the newest JSON (last write wins), even across Activity
     * instances. Identical content is not rewritten.
     */
    private void flushPendingState() {
        synchronized (FILE_LOCK) {
            String json = pendingState.getAndSet(null);
            if (json == null || json.equals(lastWrittenState)) return;
            try {
                writeTextFile(file(STATE_FILE), json);
                lastWrittenState = json;
            } catch (IOException | RuntimeException e) {
                Log.w(TAG, "Saving state failed; will retry on the next save", e);
                pendingState.compareAndSet(null, json); // keep it unless something newer arrived
            }
        }
    }

    /** UI thread (onStop): runs a flush on ioExec (after any queued writes) and waits up to timeoutMs. */
    private void flushStateBlocking(long timeoutMs) {
        try {
            ioExec.submit(this::flushPendingState).get(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            Log.w(TAG, "State flush still running after " + timeoutMs + " ms; it finishes in the background");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (Exception e) { // ExecutionException, RejectedExecutionException
            Log.w(TAG, "State flush failed", e);
        }
    }

    /** Normalized saved laptop URL, or the default when nothing is saved. */
    private String laptopUrl() {
        String u = laptopUrlCache;
        if (u == null) {
            synchronized (CONFIG_LOCK) {
                u = laptopUrlCache;
                if (u == null) {
                    String saved;
                    synchronized (FILE_LOCK) {
                        saved = readTextFile(file(LAPTOP_URL_FILE));
                    }
                    u = normalizeUrl(saved);
                    laptopUrlCache = u;
                }
            }
        }
        return u.isEmpty() ? DEFAULT_LAPTOP_URL : u;
    }

    /** "" clears the saved URL (back to the default); anything else must be an http(s) URL. */
    private void saveLaptopUrlInternal(String url) {
        if (url == null) return;
        String clean = normalizeUrl(url);
        if (!clean.isEmpty() && !isHttpUrl(clean)) {
            Log.w(TAG, "saveLaptopUrl ignored: not an http(s) URL");
            return;
        }
        synchronized (CONFIG_LOCK) {
            laptopUrlCache = clean;
        }
        // The task writes whatever is newest when it runs, so rapid changes end with the last one.
        executeQuietly(ioExec, () -> writeConfigFile(LAPTOP_URL_FILE, laptopUrlCache));
    }

    /**
     * The saved pairing token, or "" when there is none (not paired, invalid or undecryptable).
     * ioExec / netExec only: the first call reads and decrypts the file (Keystore work).
     */
    private String syncToken() {
        String t = syncTokenCache.get();
        if (t != null) return t;
        synchronized (TOKEN_LOCK) {
            t = syncTokenCache.get();
            if (t != null) return t;
            String stored;
            synchronized (FILE_LOCK) {
                stored = readTextFile(file(SYNC_TOKEN_FILE));
            }
            boolean legacy = !stored.isEmpty() && !stored.startsWith(TOKEN_ENVELOPE_PREFIX);
            String loaded = legacy ? stored : decryptToken(stored);
            if (!isValidSyncToken(loaded)) {
                if (!stored.isEmpty()) Log.w(TAG, "Saved sync token is unusable; treating the app as not paired");
                loaded = "";
                legacy = false;
            }
            if (!syncTokenCache.compareAndSet(null, loaded)) return syncTokenCache.get(); // a save won
            // Legacy plain-text token (written by an older version): use it, then encrypt it.
            if (legacy) executeQuietly(ioExec, this::persistSyncToken);
            return loaded;
        }
    }

    /**
     * JavaBridge thread, memory only: true iff the token is valid and was queued for encrypted
     * storage (Keystore work runs on ioExec). The token value is never logged.
     */
    private boolean saveSyncTokenInternal(String token) {
        String clean = token == null ? "" : token.trim();
        if (!isValidSyncToken(clean)) {
            Log.w(TAG, "saveSyncToken ignored: not 32-256 printable ASCII characters");
            return false;
        }
        syncTokenCache.set(clean);
        return executeQuietly(ioExec, this::persistSyncToken);
    }

    /**
     * ioExec: encrypts the newest token (whatever it is when this runs, so rapid saves end with
     * the last one) and writes the envelope atomically. On a Keystore failure nothing is written:
     * the token is never stored in plain text.
     */
    private void persistSyncToken() {
        String token = syncTokenCache.get();
        if (token == null || token.isEmpty()) return;
        String envelope;
        try {
            envelope = encryptToken(token);
        } catch (GeneralSecurityException | IOException | RuntimeException e) {
            Log.w(TAG, "Encrypting the sync token failed; it is kept in memory only", e);
            return;
        }
        synchronized (FILE_LOCK) {
            // A newer token arrived while this one was encrypted (possibly on a recreated
            // Activity's ioExec): its own queued task writes it, so never overwrite it with this one.
            if (!token.equals(syncTokenCache.get())) return;
            writeConfigFile(SYNC_TOKEN_FILE, envelope);
        }
    }

    private static boolean isValidSyncToken(String token) {
        return token != null && SYNC_TOKEN_RE.matcher(token).matches();
    }

    /** "v2:" + Base64(iv) + ":" + Base64(ciphertext) with the AndroidKeyStore AES-256-GCM key. */
    private static String encryptToken(String token) throws GeneralSecurityException, IOException {
        Cipher cipher = Cipher.getInstance(TOKEN_CIPHER);
        cipher.init(Cipher.ENCRYPT_MODE, tokenKey(true)); // the Keystore picks a fresh random IV
        byte[] ct = cipher.doFinal(token.getBytes(StandardCharsets.UTF_8));
        return TOKEN_ENVELOPE_PREFIX + Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP)
                + ":" + Base64.encodeToString(ct, Base64.NO_WRAP);
    }

    /**
     * Decrypts a "v2:" envelope; "" for an empty, malformed (IllegalArgumentException: bad Base64)
     * or undecryptable one (GeneralSecurityException: key gone, tampered data). Never throws.
     */
    private static String decryptToken(String envelope) {
        if (envelope.isEmpty()) return "";
        try {
            String[] parts = envelope.substring(TOKEN_ENVELOPE_PREFIX.length()).split(":", -1);
            if (parts.length != 2) throw new IllegalArgumentException("malformed token envelope");
            byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
            byte[] ct = Base64.decode(parts[1], Base64.NO_WRAP);
            SecretKey key = tokenKey(false);
            if (key == null) throw new GeneralSecurityException("token key missing");
            Cipher cipher = Cipher.getInstance(TOKEN_CIPHER);
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_BITS, iv));
            return new String(cipher.doFinal(ct), StandardCharsets.UTF_8);
        } catch (GeneralSecurityException | IOException | RuntimeException e) {
            Log.w(TAG, "Decrypting the sync token failed", e);
            return "";
        }
    }

    /** The AndroidKeyStore AES-256-GCM key (non-exportable); created on first use when asked. */
    private static synchronized SecretKey tokenKey(boolean create) throws GeneralSecurityException, IOException {
        KeyStore ks = KeyStore.getInstance(KEYSTORE_PROVIDER);
        ks.load(null);
        Key existing = ks.getKey(TOKEN_KEY_ALIAS, null);
        if (existing instanceof SecretKey) return (SecretKey) existing;
        if (!create) return null;
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_PROVIDER);
        gen.init(new KeyGenParameterSpec.Builder(TOKEN_KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(TOKEN_KEY_BITS)
                .build());
        return gen.generateKey();
    }

    /** ioExec: atomically writes a small config file. */
    private void writeConfigFile(String name, String value) {
        if (value == null) return;
        synchronized (FILE_LOCK) {
            try {
                writeTextFile(file(name), value);
            } catch (IOException | RuntimeException e) {
                Log.w(TAG, "Saving " + name + " failed", e);
            }
        }
    }

    /**
     * Reads a whole text file through AtomicFile (which also recovers an interrupted write and
     * reads the legacy plain files as-is). Returns "" if missing or unreadable.
     * Caller holds FILE_LOCK.
     */
    private static String readTextFile(File f) {
        try {
            return new String(new AtomicFile(f).readFully(), StandardCharsets.UTF_8).trim();
        } catch (FileNotFoundException e) {
            return "";
        } catch (IOException | RuntimeException e) {
            Log.w(TAG, "Reading " + f.getName() + " failed", e);
            return "";
        }
    }

    /** Replaces a file atomically (AtomicFile: write aside, fsync, rename). Caller holds FILE_LOCK. */
    private static void writeTextFile(File f, String text) throws IOException {
        AtomicFile af = new AtomicFile(f);
        FileOutputStream out = af.startWrite();
        try {
            out.write(text.getBytes(StandardCharsets.UTF_8));
            af.finishWrite(out);
        } catch (IOException | RuntimeException e) {
            af.failWrite(out); // the previous file content stays intact
            throw e;
        }
    }

    // =======================================================================================
    // Laptop sync (netExec)
    // =======================================================================================

    /** Outcome of one POST against one candidate base URL. */
    private static final class Attempt {
        final String url;
        String reason = "error";
        int code;          // HTTP status if the server answered, else 0
        long ms;
        String body = "";
        boolean connected; // the TCP connection was established (or reused)
        boolean answered;  // an HTTP status was received: the server WAS reached -> no failover

        Attempt(String url) {
            this.url = url;
        }
    }

    /**
     * One sync round, shared by the sync thread and the watchdog. Whichever side finishes it
     * first (normally the sync thread, or the hard stop for a stuck thread) delivers the result;
     * the other side's result is dropped.
     */
    private static final class SyncRound {
        final String requestId;
        final long started;
        final AtomicBoolean finished = new AtomicBoolean(false);
        volatile ScheduledFuture<?> hardStop;
        /** Connection of the attempt in progress, so the hard stop / onDestroy can close it. */
        volatile HttpURLConnection conn;

        private final JSONArray attempts = new JSONArray(); // guarded by this
        private String bestFailure;                          // guarded by this
        private String activeUrl;                            // guarded by this
        private long activeStart;                            // guarded by this
        private boolean activeConnected;                     // guarded by this

        SyncRound(String requestId, long started) {
            this.requestId = requestId;
            this.started = started;
        }

        synchronized void begin(String url, long t0) {
            activeUrl = url;
            activeStart = t0;
            activeConnected = false;
        }

        synchronized void markConnected() {
            activeConnected = true;
        }

        /** Every attempt that ran is recorded exactly once, when it ends. */
        synchronized void record(Attempt a) {
            attempts.put(attemptJson(a.url, a.reason, a.ms));
            activeUrl = null;
        }

        synchronized void recordSkipped(String url, String reason) {
            attempts.put(attemptJson(url, reason, 0));
        }

        /** Keeps the most informative failure (ties: the earlier one). */
        synchronized void noteFailure(String reason) {
            if (bestFailure == null || failureRank(reason) > failureRank(bestFailure)) bestFailure = reason;
        }

        synchronized String finalFailure() {
            return bestFailure != null ? bestFailure : "unreachable";
        }

        /** A copy, so a stuck thread that is still recording cannot touch a delivered result. */
        synchronized JSONArray attemptsCopy() {
            JSONArray copy = new JSONArray();
            for (int i = 0; i < attempts.length(); i++) copy.put(attempts.opt(i));
            return copy;
        }

        /** Result for a round abandoned by the hard stop: the recorded attempts plus the stuck one. */
        synchronized JSONObject abandonedResult(long now) {
            JSONArray list = attemptsCopy();
            String reason = finalFailure();
            if (activeUrl != null) {
                String stuck = activeConnected ? "server_timeout" : "unreachable";
                list.put(attemptJson(activeUrl, stuck, now - activeStart));
                if (bestFailure == null || failureRank(stuck) > failureRank(bestFailure)) reason = stuck;
            }
            return syncResult(requestId, false, reason, null, 0, started, list, "");
        }
    }

    /** An attempt's hard deadline: when it fires it closes the connection (watchdog thread). */
    private static final class AttemptDeadline implements Runnable {
        private final HttpURLConnection conn;
        volatile boolean fired;
        volatile ScheduledFuture<?> future;

        AttemptDeadline(HttpURLConnection conn) {
            this.conn = conn;
        }

        @Override
        public void run() {
            fired = true;
            // Android: HttpEngine.cancel() closes the raw socket, which unblocks a stalled
            // request-body write or response read in the sync thread with an IOException.
            disconnectQuietly(conn);
        }

        void cancel() {
            ScheduledFuture<?> f = future;
            if (f != null) f.cancel(false);
        }
    }

    /** netExec: one whole round, from start to delivery (exactly once) of its result. */
    private void runRound(ExecutorService exec, String requestId, String candidateUrlsJson,
                          String payloadJson, boolean force) {
        final SyncRound round = new SyncRound(requestId, SystemClock.elapsedRealtime());
        activeRound.set(round);
        round.hardStop = scheduleQuietly(() -> hardStopRound(round, exec),
                SYNC_BUDGET_MS + ATTEMPT_KILL_SLACK_MS + ROUND_ABANDON_GRACE_MS);
        JSONObject result;
        try {
            result = runSync(round, candidateUrlsJson, payloadJson, force);
        } catch (Throwable t) { // never leave the page waiting
            Log.e(TAG, "Sync crashed", t);
            result = syncResult(requestId, false, "error", null, 0, round.started, new JSONArray(), "");
        }
        if (!round.finished.compareAndSet(false, true)) return; // the hard stop already answered
        ScheduledFuture<?> hs = round.hardStop;
        if (hs != null) hs.cancel(false);
        activeRound.compareAndSet(round, null);
        // Cleared before delivery, so a rerun started from the callback is accepted.
        syncBusy.set(false);
        postJs(jsCall("__huntSyncDone", toJsLiteral(result)));
    }

    /**
     * Watchdog, last resort: the round's thread is still busy although every attempt deadline
     * has passed (closing its socket did not unblock it). JS gets a failure now and busy is
     * released, so the busy flag never outlives start + budget + a few seconds. Later rounds run
     * on a fresh thread; whatever the stuck thread produces afterwards is dropped.
     */
    private void hardStopRound(SyncRound round, ExecutorService exec) {
        if (!round.finished.compareAndSet(false, true)) return; // it finished in time (normal)
        long now = SystemClock.elapsedRealtime();
        Log.w(TAG, "Sync still running " + (now - round.started) + " ms after it started; abandoning it");
        JSONObject result = round.abandonedResult(now);
        activeRound.compareAndSet(round, null);
        // Swap the executor BEFORE releasing busy, so no new round can queue behind the stuck one.
        if (!destroyed && netExec == exec) netExec = newNetExec();
        exec.shutdownNow();
        syncBusy.set(false);
        postJs(jsCall("__huntSyncDone", toJsLiteral(result)));
        disconnectQuietly(round.conn); // best effort, after the release
    }

    /** UI thread (onDestroy): closes the in-flight request, off the UI thread. */
    private void abortActiveSync() {
        SyncRound r = activeRound.get();
        final HttpURLConnection c = r == null ? null : r.conn;
        if (c != null) scheduleQuietly(() -> disconnectQuietly(c), 0);
    }

    /** The round was abandoned (hard stop) or the Activity is going away: start nothing new. */
    private boolean stopped(SyncRound round) {
        return destroyed || round.finished.get();
    }

    /**
     * Runs one sync round on netExec and returns the result object for window.__huntSyncDone.
     * Candidates are tried in order; the first that answers (any HTTP status) ends the round.
     */
    private JSONObject runSync(SyncRound round, String candidateUrlsJson, String payloadJson, boolean force) {
        final String requestId = round.requestId;
        final long started = round.started;
        // Not paired: answer "auth" right away, before any network I/O.
        final String token = syncToken();
        if (token.isEmpty()) {
            return syncResult(requestId, false, "auth", null, 0, started, new JSONArray(), "");
        }
        List<String> candidates = parseCandidates(candidateUrlsJson);
        if (candidates.isEmpty()) candidates.add(fallbackLaptopUrl());

        if (!hasActiveNetwork()) {
            return syncResult(requestId, false, "no_network", null, 0, started, new JSONArray(), "");
        }

        // Tailscale (100.64.0.0/10) only routes through the VPN. Without one, skip those
        // candidates unless forced (manual Sync Now) or nothing else would be tried.
        boolean skipCgnat = false;
        if (!force) {
            boolean anyCgnat = false;
            boolean anyOther = false;
            for (String c : candidates) {
                if (isCgnatHost(hostOf(c))) anyCgnat = true; else anyOther = true;
            }
            skipCgnat = anyCgnat && anyOther && !anyVpnNetwork();
        }

        byte[] body = (payloadJson == null ? "" : payloadJson).getBytes(StandardCharsets.UTF_8);

        for (String url : candidates) {
            if (stopped(round)) break; // nobody will read the rest
            if (skipCgnat && isCgnatHost(hostOf(url))) {
                round.recordSkipped(url, "skipped_no_vpn");
                continue;
            }
            long remaining = SYNC_BUDGET_MS - (SystemClock.elapsedRealtime() - started);
            if (remaining < MIN_ATTEMPT_MS) {
                round.recordSkipped(url, "skipped_budget");
                continue;
            }

            Attempt a = postOnce(round, url, body, token, remaining);
            if (a.connected && "error".equals(a.reason) && !stopped(round)) {
                // A transport error after connecting is usually a keep-alive socket the server
                // closed a moment earlier (Node drops idle sockets after 5 s, about our sync
                // cadence) and HttpURLConnection does not retry it. The merge is idempotent, so
                // retry once on a fresh connection before moving on.
                long left = SYNC_BUDGET_MS - (SystemClock.elapsedRealtime() - started);
                if (left >= MIN_ATTEMPT_MS) {
                    round.record(a);
                    a = postOnce(round, url, body, token, left);
                }
            }
            round.record(a);
            if ("ok".equals(a.reason)) {
                return syncResult(requestId, true, "ok", a.url, a.code, started, round.attemptsCopy(), a.body);
            }
            if (a.answered) { // auth / too_large / http_<code>: the server was reached, stop
                return syncResult(requestId, false, a.reason, a.url, a.code, started, round.attemptsCopy(), "");
            }
            round.noteFailure(a.reason);
        }
        return syncResult(requestId, false, round.finalFailure(), null, 0, started, round.attemptsCopy(), "");
    }

    /**
     * One POST {base}/api/sync. Never throws; classifies the outcome into Attempt.reason.
     * Bounded end to end: hostname lookup (dnsExec wait), connect/read timeouts, and a hard
     * deadline that closes the socket (a stalled upload has no other timeout on Android).
     */
    private Attempt postOnce(SyncRound round, String baseUrl, byte[] body, String token, long budgetMs) {
        Attempt a = new Attempt(baseUrl);
        long t0 = SystemClock.elapsedRealtime();
        round.begin(baseUrl, t0);
        HttpURLConnection conn = null;
        AttemptDeadline deadline = null;
        boolean connected = false;
        InetSocketAddress target = null; // where an ambiguous connect failure is probed
        long connectTimeout = 1;
        long connectStart = t0;
        try {
            URL endpoint = new URL(baseUrl + "/api/sync");
            String host = endpoint.getHost();
            int port = endpoint.getPort() > 0 ? endpoint.getPort() : endpoint.getDefaultPort();
            connectTimeout = isPrivateLanHost(host) ? CONNECT_TIMEOUT_LAN_MS : CONNECT_TIMEOUT_OTHER_MS;
            connectTimeout = Math.max(1, Math.min(connectTimeout, budgetMs));

            // Hostnames are resolved first with a bounded wait (failing as "unreachable"); the
            // connection's own lookup right after is then answered from the resolver cache.
            target = new InetSocketAddress(resolveBounded(host, connectTimeout), port);
            long left = budgetMs - (SystemClock.elapsedRealtime() - t0);
            connectTimeout = Math.max(1, Math.min(connectTimeout, left));
            long readTimeout = Math.max(MIN_ATTEMPT_MS, Math.min(READ_TIMEOUT_MS, left - connectTimeout));

            conn = (HttpURLConnection) endpoint.openConnection(); // no I/O yet
            conn.setRequestMethod("POST");
            conn.setConnectTimeout((int) connectTimeout);
            conn.setReadTimeout((int) readTimeout);
            conn.setDoOutput(true);
            conn.setUseCaches(false);
            conn.setInstanceFollowRedirects(false);
            // No streaming mode on purpose: a buffered body lets HttpURLConnection transparently
            // retry on a stale keep-alive connection.
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            conn.setRequestProperty("Accept", "application/json");
            conn.setRequestProperty("X-Hunt-Token", token);
            conn.setRequestProperty("X-Hunt-Client", "android");

            connectStart = SystemClock.elapsedRealtime();
            long killAt = Math.min(connectStart + connectTimeout + readTimeout, round.started + SYNC_BUDGET_MS)
                    + ATTEMPT_KILL_SLACK_MS;
            round.conn = conn;
            deadline = new AttemptDeadline(conn);
            deadline.future = scheduleQuietly(deadline, killAt - connectStart);

            conn.connect(); // TCP connect (or a pooled keep-alive connection)
            connected = true;
            a.connected = true;
            round.markConnected();

            try (OutputStream out = conn.getOutputStream()) {
                out.write(body);
            }
            int code = conn.getResponseCode();
            if (code >= 200 && code < 300) {
                a.body = readAll(conn.getInputStream(), MAX_RESPONSE_BYTES);
                a.code = code;
                a.answered = true;
                a.reason = "ok";
            } else if (code >= 100) {
                drainQuietly(conn.getErrorStream());
                a.code = code;
                a.answered = true;
                a.reason = code == 401 ? "auth" : code == 413 ? "too_large" : "http_" + code;
            } else {
                a.reason = "error"; // not a valid HTTP response
            }
        } catch (MalformedURLException e) {
            a.reason = "error";
        } catch (SocketTimeoutException e) {
            // Before connecting: SYN unanswered (host asleep/away). After: server accepted but stalls.
            a.reason = connected ? "server_timeout" : "unreachable";
        } catch (ConnectException e) {
            if (connected) {
                a.reason = "error";
            } else if (deadline != null && deadline.fired) {
                a.reason = "unreachable"; // our own deadline closed it (also set in finally)
            } else {
                long connectLeft = connectTimeout - (SystemClock.elapsedRealtime() - connectStart);
                a.reason = classifyConnectFailure(e, target, Math.min(connectLeft, PROBE_TIMEOUT_MAX_MS));
            }
        } catch (UnknownHostException e) {
            a.reason = "unreachable";
        } catch (IOException e) {
            // Pre-connect: NoRouteToHostException and friends. Post-connect: reset/EOF mid-exchange.
            a.reason = connected ? "error" : "unreachable";
        } catch (RuntimeException e) {
            Log.w(TAG, "Sync attempt to " + baseUrl + " failed", e);
            a.reason = "error";
        } finally {
            if (deadline != null) deadline.cancel();
            round.conn = null;
            // Bodies were read to EOF and closed, so a healthy keep-alive connection is already
            // back in the pool; disconnect() then only tears down broken ones.
            disconnectQuietly(conn);
            if (deadline != null && deadline.fired && !a.answered) {
                // The hard deadline closed the socket mid-attempt: whatever exception that caused,
                // the attempt stalled.
                a.reason = connected ? "server_timeout" : "unreachable";
            }
            a.ms = SystemClock.elapsedRealtime() - t0;
        }
        return a;
    }

    /**
     * Resolves a candidate host with a bounded wait. A canonical IPv4 literal is used as-is (no
     * lookup). Anything else is looked up on dnsExec; a lookup still running after timeoutMs
     * keeps running there (getaddrinfo cannot be interrupted) and this attempt fails with
     * UnknownHostException, i.e. "unreachable".
     */
    private InetAddress resolveBounded(final String host, long timeoutMs) throws UnknownHostException {
        byte[] v4 = parseIpv4Literal(host);
        if (v4 != null) {
            InetAddress literal = InetAddress.getByAddress(host, v4); // never resolves
            if (literal.getHostAddress().equals(host)) return literal;
        }
        Future<InetAddress> lookup;
        try {
            lookup = dnsExec.submit(() -> InetAddress.getAllByName(host)[0]);
        } catch (RejectedExecutionException e) {
            throw new UnknownHostException(host + ": no free resolver thread");
        }
        try {
            return lookup.get(Math.max(1, timeoutMs), TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            lookup.cancel(true);
            throw new UnknownHostException(host + ": lookup timed out after " + timeoutMs + " ms");
        } catch (ExecutionException e) {
            throw new UnknownHostException(host + ": " + e.getCause());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new UnknownHostException(host + ": lookup interrupted");
        }
    }

    /**
     * Classifies a failed TCP connect (before any HTTP exchange).
     *
     * <p>Errno text in the exception chain decides when present. Android's bundled OkHttp,
     * however, rethrows every connect failure as a bare "Failed to connect to /host:port" and
     * drops the cause, so an RST from a laptop that is not running Hunt and an ICMP reject from a
     * router look the same. Then a raw socket probe to the same address decides: libcore reports
     * ECONNREFUSED -> "refused"; it connects now -> "error" (transient); anything else
     * (no route, net/host unreachable, timeout) -> "unreachable". Without a usable probe the
     * neutral "unreachable" is returned, never "refused".
     */
    private static String classifyConnectFailure(ConnectException e, InetSocketAddress target, long probeTimeoutMs) {
        String fromText = classifyByErrnoText(e);
        if (fromText != null) return fromText;
        if (target == null || target.isUnresolved() || probeTimeoutMs < 1) return "unreachable";
        return probeConnect(target, (int) Math.min(probeTimeoutMs, PROBE_TIMEOUT_MAX_MS));
    }

    /** "refused" / "unreachable" when the exception chain names the errno, else null. */
    private static String classifyByErrnoText(Throwable e) {
        Throwable t = e;
        for (int depth = 0; t != null && depth < 8; depth++, t = t.getCause()) {
            if (isRefusal(t)) return "refused";
            String m = t.getMessage();
            if (m != null && (m.contains("ENETUNREACH") || m.contains("EHOSTUNREACH") || m.contains("EADDRNOTAVAIL")
                    || m.contains("ETIMEDOUT") || m.contains("unreachable") || m.contains("No route to host"))) {
                return "unreachable";
            }
        }
        return null;
    }

    /** One element of a chain: ECONNREFUSED by message (libcore and desktop JVMs) or by errno. */
    private static boolean isRefusal(Throwable t) {
        String m = t.getMessage();
        if (m != null && (m.contains("ECONNREFUSED") || m.contains("Connection refused"))) return true;
        return t instanceof ErrnoException && ((ErrnoException) t).errno == OsConstants.ECONNREFUSED;
    }

    private static boolean chainHasRefusal(Throwable e) {
        Throwable t = e;
        for (int depth = 0; t != null && depth < 8; depth++, t = t.getCause()) {
            if (isRefusal(t)) return true;
        }
        return false;
    }

    /** netExec: raw TCP connect to classify an ambiguous failure. Always closed again. */
    private static String probeConnect(InetSocketAddress target, int timeoutMs) {
        Socket probe = new Socket();
        try {
            probe.connect(target, Math.max(1, timeoutMs)); // 0 would mean "no timeout"
            return "error"; // it accepts now: the failure a moment ago was transient
        } catch (ConnectException e) {
            return chainHasRefusal(e) ? "refused" : "unreachable";
        } catch (IOException | RuntimeException e) {
            // SocketTimeoutException, NoRouteToHostException (EHOSTUNREACH), ...
            return "unreachable";
        } finally {
            try {
                probe.close();
            } catch (IOException ignored) {
                // nothing to release beyond the fd, which close() frees anyway
            }
        }
    }

    /** Higher = more informative final reason when every candidate failed (ties: earlier wins). */
    private static int failureRank(String reason) {
        switch (reason) {
            case "refused":
            case "server_timeout":
                return 3;
            case "error":
                return 2;
            case "unreachable":
                return 1;
            default:
                return 0;
        }
    }

    private static JSONObject attemptJson(String url, String reason, long ms) {
        JSONObject o = new JSONObject();
        try {
            o.put("url", url);
            o.put("reason", reason);
            o.put("ms", (int) ms);
        } catch (JSONException ignored) {
            // keys and values are never invalid here
        }
        return o;
    }

    private static JSONObject syncResult(String id, boolean ok, String reason, String url, int code,
                                         long started, JSONArray attempts, String body) {
        JSONObject r = new JSONObject();
        try {
            r.put("id", id == null ? JSONObject.NULL : id);
            r.put("ok", ok);
            r.put("reason", reason);
            r.put("url", url == null ? JSONObject.NULL : url);
            r.put("code", code);
            r.put("ms", (int) (SystemClock.elapsedRealtime() - started));
            r.put("attempts", attempts);
            r.put("body", body == null ? "" : body);
        } catch (JSONException ignored) {
            // keys and values are never invalid here
        }
        return r;
    }

    /** JSON array of base URLs -> normalized http(s) URLs, deduped in order, at most MAX_CANDIDATES. */
    private static List<String> parseCandidates(String json) {
        List<String> out = new ArrayList<>();
        if (json == null || json.trim().isEmpty()) return out;
        JSONArray arr;
        try {
            arr = new JSONArray(json);
        } catch (JSONException e) {
            Log.w(TAG, "Bad candidate URL list", e);
            return out;
        }
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < arr.length() && out.size() < MAX_CANDIDATES; i++) {
            Object v = arr.opt(i);
            if (!(v instanceof String)) continue;
            String url = normalizeUrl((String) v);
            if (isHttpUrl(url) && seen.add(url.toLowerCase(Locale.ROOT))) out.add(url);
        }
        return out;
    }

    private String fallbackLaptopUrl() {
        String u = laptopUrl();
        return isHttpUrl(u) ? u : DEFAULT_LAPTOP_URL;
    }

    /** Trim and strip trailing slashes. */
    private static String normalizeUrl(String raw) {
        if (raw == null) return "";
        String s = raw.trim();
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        return s;
    }

    /** http:// or https:// with a non-empty host (pure parsing, no I/O). */
    private static boolean isHttpUrl(String url) {
        String lower = url.toLowerCase(Locale.ROOT);
        if (!lower.startsWith("http://") && !lower.startsWith("https://")) return false;
        try {
            String host = new URL(url).getHost();
            return host != null && !host.isEmpty();
        } catch (MalformedURLException e) {
            return false;
        }
    }

    private static String hostOf(String url) {
        try {
            return new URL(url).getHost();
        } catch (MalformedURLException e) {
            return "";
        }
    }

    /**
     * Parses a dotted-quad IPv4 literal ("192.168.2.136") into 4 bytes; null for anything else
     * (hostnames, IPv6). Never does a DNS lookup.
     */
    private static byte[] parseIpv4Literal(String host) {
        if (host == null) return null;
        String[] parts = host.split("\\.", -1);
        if (parts.length != 4) return null;
        byte[] bytes = new byte[4];
        for (int i = 0; i < 4; i++) {
            String p = parts[i];
            if (p.isEmpty() || p.length() > 3) return null;
            int v = 0;
            for (int k = 0; k < p.length(); k++) {
                char c = p.charAt(k);
                if (c < '0' || c > '9') return null;
                v = v * 10 + (c - '0');
            }
            if (v > 255) return null;
            bytes[i] = (byte) v;
        }
        return bytes;
    }

    /** 10/8, 172.16/12, 192.168/16 (RFC1918). Hostnames that are not IPv4 literals: false. */
    private static boolean isPrivateLanHost(String host) {
        byte[] b = parseIpv4Literal(host);
        if (b == null) return false;
        try {
            // getByAddress never resolves; isSiteLocalAddress is exactly the RFC1918 ranges for IPv4.
            return InetAddress.getByAddress(b).isSiteLocalAddress();
        } catch (UnknownHostException e) {
            return false;
        }
    }

    /** 100.64.0.0/10 (carrier-grade NAT range, used by Tailscale). */
    private static boolean isCgnatHost(String host) {
        byte[] b = parseIpv4Literal(host);
        return b != null && (b[0] & 0xFF) == 100 && (b[1] & 0xC0) == 64;
    }

    private static String readAll(InputStream in, int maxBytes) throws IOException {
        if (in == null) return "";
        try (InputStream is = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream(16 * 1024);
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = is.read(buf)) != -1) {
                out.write(buf, 0, n);
                if (out.size() > maxBytes) throw new IOException("Response larger than " + maxBytes + " bytes");
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    /** Reads (a bounded amount of) an error body and closes it, so the connection can be reused. */
    private static void drainQuietly(InputStream in) {
        if (in == null) return;
        try (InputStream is = in) {
            byte[] buf = new byte[8 * 1024];
            int total = 0;
            int n;
            while (total < MAX_ERROR_DRAIN_BYTES && (n = is.read(buf)) != -1) total += n;
        } catch (IOException ignored) {
            // nothing to recover
        }
    }

    // =======================================================================================
    // Misc helpers
    // =======================================================================================

    @SuppressWarnings("deprecation") // getPackageInfo(String,int) / versionCode below API 28
    private String readAppVersion() {
        try {
            PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
            long code = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                    ? info.getLongVersionCode() : info.versionCode;
            return info.versionName + " (" + code + ")";
        } catch (Exception e) {
            return "";
        }
    }

    /** False when the executor is shut down (the Activity is being destroyed). */
    private static boolean executeQuietly(ExecutorService exec, Runnable task) {
        try {
            exec.execute(task);
            return true;
        } catch (RejectedExecutionException e) {
            return false;
        }
    }

    /** Runs task on the watchdog after delayMs; null once it is shut down (Activity destroyed). */
    private ScheduledFuture<?> scheduleQuietly(Runnable task, long delayMs) {
        try {
            return watchdog.schedule(task, Math.max(0, delayMs), TimeUnit.MILLISECONDS);
        } catch (RejectedExecutionException e) {
            return null;
        }
    }

    private static void disconnectQuietly(HttpURLConnection c) {
        if (c == null) return;
        try {
            c.disconnect();
        } catch (RuntimeException ignored) {
            // already torn down
        }
    }

    private static ExecutorService newNetExec() {
        return Executors.newSingleThreadExecutor(namedThreads("hunt-net"));
    }

    private static ScheduledThreadPoolExecutor newWatchdog() {
        ScheduledThreadPoolExecutor s = new ScheduledThreadPoolExecutor(1, namedThreads("hunt-watchdog"));
        s.setRemoveOnCancelPolicy(true); // cancelled deadlines (the normal case) don't pile up
        return s;
    }

    private static ThreadFactory namedThreads(final String name) {
        return r -> {
            Thread t = new Thread(r, name);
            t.setDaemon(true);
            return t;
        };
    }

    // =======================================================================================
    // window.AndroidBridge (runs on WebView's JavaBridge thread; every method returns in ms)
    // =======================================================================================

    public final class AndroidNativeBridge {

        /** Newest state JSON, or "" when there is none. */
        @JavascriptInterface
        public String loadState() {
            try {
                return loadStateInternal();
            } catch (RuntimeException e) {
                Log.w(TAG, "loadState failed", e);
                return "";
            }
        }

        /** Remembers the JSON and writes it asynchronously (coalesced, atomic). */
        @JavascriptInterface
        public void saveState(String json) {
            try {
                saveStateInternal(json);
            } catch (RuntimeException e) {
                Log.w(TAG, "saveState failed", e);
            }
        }

        @JavascriptInterface
        public String getLaptopUrl() {
            try {
                return laptopUrl();
            } catch (RuntimeException e) {
                return DEFAULT_LAPTOP_URL;
            }
        }

        @JavascriptInterface
        public void saveLaptopUrl(String url) {
            try {
                saveLaptopUrlInternal(url);
            } catch (RuntimeException e) {
                Log.w(TAG, "saveLaptopUrl failed", e);
            }
        }

        /**
         * Stores the pairing token (write-only: the page can never read it back). True iff it is
         * 32-256 printable ASCII characters and was queued for Keystore-encrypted storage.
         */
        @JavascriptInterface
        public boolean saveSyncToken(String token) {
            try {
                return saveSyncTokenInternal(token);
            } catch (RuntimeException e) {
                Log.w(TAG, "saveSyncToken failed", e);
                return false;
            }
        }

        /**
         * Starts a sync on netExec and returns at once: true if started, false if a sync is
         * already running (busy) or the Activity is going away. The result arrives via
         * {@code window.__huntSyncDone(result)} on the UI thread.
         */
        @JavascriptInterface
        public boolean syncWithLaptopAsync(final String requestId, final String candidateUrlsJson,
                                           final String payloadJson, final boolean force) {
            if (destroyed || !syncBusy.compareAndSet(false, true)) return false;
            final ExecutorService exec = netExec;
            try {
                exec.execute(() -> runRound(exec, requestId, candidateUrlsJson, payloadJson, force));
                return true;
            } catch (RejectedExecutionException e) {
                syncBusy.set(false);
                return false;
            }
        }

        /** Posts to the UI thread; the window flag is only touched when the value changes. */
        @JavascriptInterface
        public void setKeepScreenOn(final boolean on) {
            main.post(() -> {
                if (destroyed) return;
                if (keepScreenOnApplied != null && keepScreenOnApplied == on) return;
                Window w = getWindow();
                if (w == null) return;
                keepScreenOnApplied = on;
                if (on) {
                    w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                } else {
                    w.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            });
        }

        /** Kept on the bridge contract as a silent no-op (no motor buzz on taps). */
        @JavascriptInterface
        public void vibrateClick() {
            // Intentionally silent: haptics disabled for clean, distraction-free taps.
        }

        /** e.g. "1.2.0 (3)". */
        @JavascriptInterface
        public String getAppVersion() {
            return appVersion;
        }
    }
}
