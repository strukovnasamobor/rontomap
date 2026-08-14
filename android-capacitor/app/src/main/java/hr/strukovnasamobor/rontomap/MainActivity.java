package hr.strukovnasamobor.rontomap;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Base64;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.util.Log;
import android.webkit.CookieManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.webkit.ServiceWorkerClientCompat;
import androidx.webkit.ServiceWorkerControllerCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

public class MainActivity extends BridgeActivity {

    // A file-open intent can arrive before the WebView has a loaded page (cold
    // start), and the page can reload right after a successful injection. Keep
    // the payload armed briefly and re-inject it on every page load in that
    // window; the snippet itself is idempotent (see buildFileOpenJs).
    private static final long FILE_OPEN_REDELIVER_MS = 60_000L;
    private String pendingFileOpenJs = null;
    private long pendingFileOpenUntilMs = 0L;
    private int fileOpenSeq = 0;
    private boolean webViewPageLoaded = false;

    // Same arrangement for share links handed to an already-running page.
    private static final long LINK_OPEN_REDELIVER_MS = 60_000L;
    private String pendingLinkOpenJs = null;
    private long pendingLinkOpenUntilMs = 0L;
    private int linkOpenSeq = 0;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register plugins BEFORE super.onCreate() so the bridge picks them up
        registerPlugin(FullscreenPlugin.class);
        registerPlugin(DownloadPlugin.class);
        registerPlugin(OfflineRoutingPlugin.class);
        registerPlugin(TileDownloadPlugin.class);
        registerPlugin(RecordingNotificationPlugin.class);

        super.onCreate(savedInstanceState);

        // Request notification permission app-wide (Android 13+) so the
        // foreground-service notifications (tile download, routing import, and
        // the background-location "recording" notification) can actually show.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                   != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this,
                    new String[]{ Manifest.permission.POST_NOTIFICATIONS }, 4713);
        }

        // Edge-to-edge: draw content behind the system bars so a transparent
        // nav/status bar actually reveals the map underneath (instead of the
        // window background). Must be set before the bars are made transparent.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
        } else {
            View decor = getWindow().getDecorView();
            decor.setSystemUiVisibility(
                    decor.getSystemUiVisibility()
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            );
        }

        // Draw into the display cutout (camera notch / punch-hole) on the short
        // edges so the map fills the screen edge-to-edge on devices like Samsung,
        // instead of being letterboxed below the camera. Web UI is kept clear of
        // the cutout via CSS env(safe-area-inset-*). API 28+.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            android.view.WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.layoutInDisplayCutoutMode =
                    android.view.WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(lp);
        }

        // Transparent system bars so the map shows through. The nav-bar color
        // is then driven from JS (setNavigationBarColor) to match the feature
        // panel when it's open in portrait.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            getWindow().setStatusBarColor(Color.TRANSPARENT);
            getWindow().setNavigationBarColor(Color.TRANSPARENT);
        }
        // Android 10+ enforces a contrast scrim on transparent system bars by
        // default — opt out so "transparent" is actually transparent.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            getWindow().setNavigationBarContrastEnforced(false);
            getWindow().setStatusBarContrastEnforced(false);
        }

        // Window background must be a non-null drawable; black so that any
        // strip not covered by the WebView (e.g. on MIUI's reported viewport)
        // is black, not the AppCompat DayNight default (~white).
        getWindow().setBackgroundDrawable(new ColorDrawable(Color.BLACK));

        // Force the Capacitor WebView itself transparent. Capacitor's Bridge
        // does this only if "backgroundColor" is set in capacitor.config.json
        // (now done), but we also re-apply it here as a hard guarantee. We
        // post() it so it runs after the bridge has finished laying out the
        // view tree — some MIUI ROMs reset the WebView background mid-init.
        applyWebViewTransparent();

        // Mode 2 (server.url): own WebSettings directly + install offline
        // fallback. Must run after super.onCreate() so the bridge's WebView
        // exists.
        configureWebViewSettings();
        installOfflineFallbackWebViewClient();
        installTileServiceWorkerInterceptor();

        handleDeepLink(getIntent());
    }

    // Map tiles for hosts Mapbox GL JS requests from.
    private static boolean isMapboxTileHost(android.net.Uri uri) {
        return uri != null && TileStore.isMapboxHost(uri.getHost());
    }

    // ---- Offline tile serving ------------------------------------------------
    //
    // Native-downloaded tiles live in filesDir/tiles (TileStore). They are
    // served back to the WebView's Mapbox GL JS by intercepting the service
    // worker's own tile fetches via ServiceWorkerControllerCompat (the primary
    // path; WebViewClient.shouldInterceptRequest does NOT see SW traffic). The
    // WebViewClient override below is a fallback for the rare case the SW isn't
    // controlling the request / the feature is unsupported.
    //
    // The interceptor only SERVES tiles from the store; TileDownloadService is
    // what populates it. (During the Phase 0 spike this was true to validate
    // serving by browsing online — now off so we don't cache while just viewing.)
    private static final boolean DEBUG_TILE_AUTOSTORE = false;

    private static volatile OkHttpClient tileHttp;

    private static OkHttpClient tileHttp() {
        OkHttpClient c = tileHttp;
        if (c == null) {
            synchronized (MainActivity.class) {
                c = tileHttp;
                if (c == null) {
                    c = new OkHttpClient.Builder()
                            .connectTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
                            .readTimeout(25, java.util.concurrent.TimeUnit.SECONDS)
                            .build();
                    tileHttp = c;
                }
            }
        }
        return c;
    }

    /**
     * Shared tile responder. Returns a stored tile, or (debug) fetches+stores
     * and returns it, or null to let the request proceed normally.
     * Runs off the UI thread (both ServiceWorkerClient and WebViewClient call
     * shouldInterceptRequest on a background thread), so blocking I/O is fine.
     */
    private WebResourceResponse serveTile(WebResourceRequest req, String source) {
        if (req == null) return null;
        if (!"GET".equalsIgnoreCase(req.getMethod())) return null;
        if (!isMapboxTileHost(req.getUrl())) return null;
        final String url = req.getUrl().toString();
        TileStore store = TileStore.get(this);

        WebResourceResponse stored = store.responseForUrl(url);
        if (stored != null) return stored;

        if (!DEBUG_TILE_AUTOSTORE) return null;
        try {
            Request r = new Request.Builder().url(url).build();
            try (Response resp = tileHttp().newCall(r).execute()) {
                ResponseBody body = resp.body();
                if (!resp.isSuccessful() || body == null) return null;
                String contentType = resp.header("Content-Type", "application/octet-stream");
                byte[] bytes = body.bytes();
                store.put(TileStore.normalizeCacheKey(url), bytes, contentType);
                return store.responseForUrl(url);
            }
        } catch (Exception e) {
            Log.w("TileSpike", "auto-store fetch failed " + url + ": " + e.getMessage());
            return null; // let the SW proceed to the network
        }
    }

    private void installTileServiceWorkerInterceptor() {
        boolean basic = WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_BASIC_USAGE);
        boolean intercept = WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_SHOULD_INTERCEPT_REQUEST);
        Log.i("TileSpike", "SW features basic=" + basic + " intercept=" + intercept);
        if (!basic || !intercept) {
            Log.w("TileSpike", "ServiceWorker intercept feature unsupported — relying on WebViewClient fallback");
            return;
        }
        try {
            ServiceWorkerControllerCompat.getInstance().setServiceWorkerClient(new ServiceWorkerClientCompat() {
                @Override
                public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                    return serveTile(request, "sw");
                }
            });
            Log.i("TileSpike", "ServiceWorkerClient installed");
        } catch (Exception e) {
            Log.w("TileSpike", "setServiceWorkerClient failed: " + e.getMessage());
        }
    }

    private void configureWebViewSettings() {
        if (getBridge() == null || getBridge().getWebView() == null) return;
        final WebView wv = getBridge().getWebView();
        final WebSettings s = wv.getSettings();

        // Identify the native wrapper to the deployed site without depending
        // on Capacitor's JS globals (which the site can also sniff, but UA is
        // more robust across SW / fetch / server-side contexts).
        String versionName = "0.0";
        try {
            versionName = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (PackageManager.NameNotFoundException ignored) {}
        s.setUserAgentString(s.getUserAgentString() + " RontoMap-Android/" + versionName);

        // Explicit so OEM defaults don't surprise us.
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setDomStorageEnabled(true);

        // capacitor.config.json sets allowMixedContent: true => ALWAYS_ALLOW.
        // For a hosted https origin, COMPATIBILITY is safer.
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        s.setAllowFileAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);

        // Third-party cookies (needed if the deployed site embeds cross-origin
        // auth/iframes).
        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(wv, true);
    }

    private void installOfflineFallbackWebViewClient() {
        if (getBridge() == null || getBridge().getWebView() == null) return;
        final WebView wv = getBridge().getWebView();
        wv.setWebViewClient(new BridgeWebViewClient(getBridge()) {
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                webViewPageLoaded = true;
                injectFileOpen();
                injectLinkOpen();
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                // Fallback tile serving for requests not handled by the SW
                // interceptor (e.g. feature unsupported). null → Capacitor's
                // normal handling.
                WebResourceResponse tile = serveTile(req, "wv");
                if (tile != null) return tile;
                return super.shouldInterceptRequest(view, req);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req != null && req.isForMainFrame()) {
                    view.loadUrl("file:///android_asset/public/offline.html");
                }
                super.onReceivedError(view, req, err);
            }
        });
    }

    private void applyWebViewTransparent() {
        if (getBridge() == null || getBridge().getWebView() == null) return;
        final WebView wv = getBridge().getWebView();
        wv.setBackgroundColor(Color.TRANSPARENT);
        wv.post(() -> wv.setBackgroundColor(Color.TRANSPARENT));
    }

    @Override
    public void onResume() {
        super.onResume();
        // Re-apply on resume — some MIUI configurations reset the WebView
        // background when the activity returns from background.
        applyWebViewTransparent();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleDeepLink(intent);
    }

    private void handleDeepLink(Intent intent) {
        String action = intent.getAction();

        // Handle shared file (share sheet)
        if (Intent.ACTION_SEND.equals(action)) {
            Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (uri != null) handleFileOpen(uri);
            return;
        }

        if (!Intent.ACTION_VIEW.equals(action)) return;
        Uri data = intent.getData();
        if (data == null) return;

        String scheme = data.getScheme();

        // File open intent (content:// or file://)
        if ("content".equals(scheme) || "file".equals(scheme)) {
            handleFileOpen(data);
            return;
        }

        // Deep link (https://rontomap.web.app/?...#...)
        //
        // Carry over BOTH the query and the fragment: shared path links keep the
        // vertex polyline (plus the base64 extras blob) in the fragment, so
        // dropping it leaves `?path` with nothing to import and the web side
        // reports "Failed to import from link".
        //
        // Use the *encoded* forms — getQuery()/getFragment() percent-decode, and
        // splicing decoded values back into a URL corrupts any name or
        // description containing & # + or %.
        String query = data.getEncodedQuery();
        String fragment = data.getEncodedFragment();
        boolean hasQuery = query != null && !query.isEmpty();
        boolean hasFragment = fragment != null && !fragment.isEmpty();
        if (!hasQuery && !hasFragment) return;
        String serverUrl = getBridge().getServerUrl();
        if (serverUrl == null) serverUrl = "http://localhost";
        StringBuilder sb = new StringBuilder(serverUrl).append("/");
        if (hasQuery) sb.append("?").append(query);
        if (hasFragment) sb.append("#").append(fragment);
        final String url = sb.toString();
        final String appOrigin = serverUrl;
        getBridge().getWebView().post(() -> {
            WebView wv = getBridge().getWebView();
            if (wv == null) return;
            if (webViewPageLoaded && isAppDocument(wv.getUrl(), appOrigin)) {
                // The app is already running on its own document: hand the link to
                // the live page instead of navigating. Any navigation here —
                // loadUrl, or the location.reload() this used to do for a
                // same-document link — throws away everything unsaved: the path
                // being drawn, unsaved markers, undo stacks, an active recording.
                try {
                    JSONObject payload = new JSONObject();
                    payload.put("search", hasQuery ? "?" + query : "");
                    payload.put("hash", hasFragment ? "#" + fragment : "");
                    String token = "ln-" + System.currentTimeMillis() + "-" + (++linkOpenSeq);
                    payload.put("token", token);
                    // Same base64-the-whole-JSON discipline as the file payload: the
                    // query carries user-authored names and descriptions and must
                    // never break out of the JS literal into an origin that has the
                    // Capacitor bridge attached.
                    String payloadB64 = Base64.encodeToString(
                            payload.toString().getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
                    pendingLinkOpenJs = buildLinkOpenJs(payloadB64, token, url);
                    pendingLinkOpenUntilMs =
                            SystemClock.elapsedRealtime() + LINK_OPEN_REDELIVER_MS;
                    injectLinkOpen();
                } catch (Exception e) {
                    e.printStackTrace();
                    wv.loadUrl(url); // fall back to the old behaviour rather than drop the link
                }
            } else {
                // Cold start, offline.html, or a WebView the system recreated: load
                // the URL and let the web app's boot-time import handle it.
                wv.loadUrl(url);
            }
        });
    }

    /** True when the WebView currently shows the web app (not offline.html / about:blank / null). */
    private static boolean isAppDocument(String current, String serverUrl) {
        return current != null && serverUrl != null && current.startsWith(serverUrl);
    }

    /**
     * Hands a share link to the already-running page. Mirrors buildFileOpenJs:
     * arm a global, dispatch a bare event, then poll for the web app to take it
     * and record the token in sessionStorage so a re-injection after a reload is
     * a no-op rather than a duplicate import. (The web side also writes the token
     * itself the moment it consumes the payload, closing the poll's ~100ms gap.)
     */
    private static String buildLinkOpenJs(String payloadB64, String token, String url) {
        return "(function(){var t=" + JSONObject.quote(token) + ",u=" + JSONObject.quote(url) + ";"
             + "try{if(sessionStorage.getItem('__rontoLinkOpen')===t)return;}catch(e){}"
             + "window.__rontoLinkOpen=JSON.parse(decodeURIComponent(escape(atob('" + payloadB64 + "'))));"
             + "window.dispatchEvent(new Event('rontomap-link-open'));"
             + "var n=0,iv=setInterval(function(){"
             + "if(typeof window.__rontoLinkOpen==='undefined'){"
             + "try{sessionStorage.setItem('__rontoLinkOpen',t);}catch(e){}clearInterval(iv);return;}"
             // Nobody took the payload within ~2s, so this page has no runtime
             // import listener — an older deployed build. Fall back to navigating
             // (the previous behaviour) rather than swallowing the link. The web
             // side deletes the global before it even decides to refuse a busy
             // import, so a refusal never reaches this branch.
             + "if(++n>20){clearInterval(iv);"
             + "var same=location.href.split('#')[0]===u.split('#')[0];"
             + "location.href=u;if(same)location.reload();}"
             + "},100);})();";
    }

    private void injectLinkOpen() {
        if (pendingLinkOpenJs == null) return;
        if (SystemClock.elapsedRealtime() > pendingLinkOpenUntilMs) {
            pendingLinkOpenJs = null; // window closed — stop re-delivering
            return;
        }
        if (getBridge() == null || getBridge().getWebView() == null) return;
        final String js = pendingLinkOpenJs;
        getBridge().getWebView().post(() ->
            getBridge().getWebView().evaluateJavascript(js, null));
    }

    private void handleFileOpen(Uri uri) {
        try {
            // Get file name from URI
            String fileName = "unknown";
            if ("content".equals(uri.getScheme())) {
                android.database.Cursor cursor = getContentResolver().query(uri, null, null, null, null);
                if (cursor != null) {
                    int nameIndex = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                    if (cursor.moveToFirst() && nameIndex >= 0) {
                        fileName = cursor.getString(nameIndex);
                    }
                    cursor.close();
                }
            } else {
                fileName = uri.getLastPathSegment();
                if (fileName == null) fileName = "unknown";
            }

            // Read file bytes
            InputStream is = getContentResolver().openInputStream(uri);
            if (is == null) return;
            // OOM guard: an import (GPX/KML/FIT/GeoJSON track) is at most a few
            // MB. Refuse anything larger so a malicious/huge file can't exhaust
            // memory (bytes are held in RAM, then ~1.33x again as base64).
            final int MAX_IMPORT_BYTES = 25 * 1024 * 1024; // 25 MB ceiling
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int len;
            while ((len = is.read(buffer)) != -1) {
                baos.write(buffer, 0, len);
                if (baos.size() > MAX_IMPORT_BYTES) {
                    is.close();
                    return; // oversized — refuse the import
                }
            }
            is.close();
            byte[] bytes = baos.toByteArray();
            String base64 = Base64.encodeToString(bytes, Base64.NO_WRAP);

            // Build the payload as JSON (escapes every field correctly), then
            // base64 the whole thing so the injected JS string literal is pure
            // [A-Za-z0-9+/=]. The (attacker-controllable) filename can therefore
            // never break out of the literal and inject script into the web
            // origin — which on Android has the native Capacitor bridge wired up.
            JSONObject payload = new JSONObject();
            payload.put("name", fileName);
            payload.put("base64", base64);
            String payloadB64 = Base64.encodeToString(
                    payload.toString().getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);

            // Cold start: onCreate() calls handleDeepLink() while the WebView is
            // still loading the app, so injecting now would target a document the
            // real page load then throws away. Worse, the page can reload *after*
            // a successful injection (the service worker does this on activation),
            // which wipes window.__importFileData before the web app consumes it —
            // in both cases the app opens and imports nothing.
            //
            // So: keep the payload armed for a short window and re-inject on every
            // page load in it. The snippet is idempotent — once the web app has
            // taken the payload (it deletes __importFileData when it does), it
            // records the token in sessionStorage, which survives a reload, so a
            // later re-injection is a no-op instead of a duplicate import.
            pendingFileOpenJs = buildFileOpenJs(
                    payloadB64, "fo-" + System.currentTimeMillis() + "-" + (++fileOpenSeq));
            pendingFileOpenUntilMs = SystemClock.elapsedRealtime() + FILE_OPEN_REDELIVER_MS;
            if (webViewPageLoaded) injectFileOpen();
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    /**
     * Arms window.__importFileData and fires the event the web app listens for.
     * Guarded by a sessionStorage token so re-injecting after a page reload can't
     * import the same file twice: the web app deletes __importFileData as soon as
     * it takes the payload, and the poll below records the token when it sees that.
     * atob() yields a binary string; escape()+decodeURIComponent() reconstitutes
     * the original UTF-8 JSON.
     */
    private static String buildFileOpenJs(String payloadB64, String token) {
        return "(function(){var t=" + JSONObject.quote(token) + ";"
             + "try{if(sessionStorage.getItem('__rontoImport')===t)return;}catch(e){}"
             + "window.__importFileData=JSON.parse(decodeURIComponent(escape(atob('" + payloadB64 + "'))));"
             + "window.dispatchEvent(new Event('rontomap-file-open'));"
             + "var n=0,iv=setInterval(function(){"
             + "if(typeof window.__importFileData==='undefined'){"
             + "try{sessionStorage.setItem('__rontoImport',t);}catch(e){}clearInterval(iv);}"
             + "else if(++n>300){clearInterval(iv);}},100);})();";
    }

    private void injectFileOpen() {
        if (pendingFileOpenJs == null) return;
        if (SystemClock.elapsedRealtime() > pendingFileOpenUntilMs) {
            pendingFileOpenJs = null; // window closed — stop re-delivering
            return;
        }
        if (getBridge() == null || getBridge().getWebView() == null) return;
        final String js = pendingFileOpenJs;
        getBridge().getWebView().post(() ->
            getBridge().getWebView().evaluateJavascript(js, null));
    }

    public void enterFullscreen() {
        // Use new API for Android 11+ (API 30+)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            final WindowInsetsController insetsController = getWindow().getInsetsController();
            if (insetsController != null) {
                // Hide both status bar and navigation bar
                insetsController.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                // Set behavior to make them stay hidden
                insetsController.setSystemBarsBehavior(
                        WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                );
            }
        } else {
            // Use old API for older Android versions
            View decorView = getWindow().getDecorView();

            int flags = View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE;

            decorView.setSystemUiVisibility(flags);

            // Re-apply flags when they change (for persistent hiding)
            decorView.setOnSystemUiVisibilityChangeListener(visibility -> {
                if ((visibility & View.SYSTEM_UI_FLAG_FULLSCREEN) == 0) {
                    decorView.setSystemUiVisibility(flags);
                }
            });
        }

        // Set transparent bars
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            getWindow().setStatusBarColor(android.graphics.Color.TRANSPARENT);
            getWindow().setNavigationBarColor(android.graphics.Color.TRANSPARENT);
        }
    }

    public void setNavigationBarColor(String colorStr) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) return;
        int color;
        if (colorStr == null || "transparent".equalsIgnoreCase(colorStr)) {
            color = android.graphics.Color.TRANSPARENT;
        } else {
            try {
                color = android.graphics.Color.parseColor(colorStr);
            } catch (IllegalArgumentException e) {
                return;
            }
        }
        getWindow().setNavigationBarColor(color);
    }

    public void exitFullscreen() {
        // Use new API for Android 11+ (API 30+)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            final WindowInsetsController insetsController = getWindow().getInsetsController();
            if (insetsController != null) {
                // Show both status bar and navigation bar
                insetsController.show(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
            }
        } else {
            // Use old API for older Android versions
            View decorView = getWindow().getDecorView();

            // Remove the listener first
            decorView.setOnSystemUiVisibilityChangeListener(null);

            // Clear all fullscreen flags
            decorView.setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }

        // Reset to transparent bars; JS (setNavigationBarColor) will re-apply
        // the panel color on the next feature-panel effect run.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            getWindow().setStatusBarColor(android.graphics.Color.TRANSPARENT);
            getWindow().setNavigationBarColor(android.graphics.Color.TRANSPARENT);
        }
    }
}