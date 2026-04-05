package hr.strukovnasamobor.rontomap;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import com.getcapacitor.BridgeActivity;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register plugins BEFORE super.onCreate() so the bridge picks them up
        registerPlugin(FullscreenPlugin.class);
        registerPlugin(DownloadPlugin.class);

        super.onCreate(savedInstanceState);

        // Set navigation bar to black on startup
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            getWindow().setNavigationBarColor(android.graphics.Color.parseColor("#000000"));
            getWindow().setStatusBarColor(android.graphics.Color.parseColor("#000000"));
        }

        handleDeepLink(getIntent());
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

        // Deep link (https://rontomap.web.app?...)
        String query = data.getQuery();
        if (query == null || query.isEmpty()) return;
        String serverUrl = getBridge().getServerUrl();
        if (serverUrl == null) serverUrl = "http://localhost";
        final String url = serverUrl + "/?" + query;
        getBridge().getWebView().post(() -> getBridge().getWebView().loadUrl(url));
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
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int len;
            while ((len = is.read(buffer)) != -1) {
                baos.write(buffer, 0, len);
            }
            is.close();
            byte[] bytes = baos.toByteArray();
            String base64 = Base64.encodeToString(bytes, Base64.NO_WRAP);

            // Escape for JS
            String escapedName = fileName.replace("\\", "\\\\").replace("'", "\\'");

            // Pass to WebView
            final String js = "javascript:window.__importFileData={name:'" + escapedName + "',base64:'" + base64 + "'};window.dispatchEvent(new Event('rontomap-file-open'));";
            getBridge().getWebView().post(() -> getBridge().getWebView().loadUrl(js));
        } catch (Exception e) {
            e.printStackTrace();
        }
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

        // Reset to default system bar colors
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            getWindow().setStatusBarColor(android.graphics.Color.parseColor("#000000"));
            getWindow().setNavigationBarColor(android.graphics.Color.parseColor("#000000"));
        }
    }
}