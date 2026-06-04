package hr.strukovnasamobor.rontomap;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * Foreground service that downloads offline map tiles into {@link TileStore}
 * (filesDir/tiles) so the download survives backgrounding — the tile analogue
 * of {@link RoutingImportService}. Mirrors the service worker's
 * handleDownloadRegion semantics (6 workers, retry/backoff, resume, progress
 * every 20 tiles, base-replace, cancellation cleanup).
 *
 * Extras:
 *   "op"        : "region" | "base"
 *   "regionId"  : long      (assigned by the plugin so JS can correlate progress)
 *   "regionJson": String    (region metadata, minus tileKeys)
 *   "urlsFile"  : String    (path to a temp file holding a JSON array of tile URLs)
 *   "isUpdate"  : boolean
 *
 * Progress is published via {@link ProgressBus} as a JSONObject mirroring the
 * SW message shapes (DOWNLOAD_PROGRESS / DOWNLOAD_ERROR / DOWNLOAD_CANCELLED).
 */
public class TileDownloadService extends Service {

    private static final String TAG = "TileDownloadService";
    private static final String CHANNEL_ID = "rontomap_tile_download";
    private static final int NOTIFICATION_ID = 4712;

    private static final int CONCURRENCY = 6;
    private static final int FETCH_RETRIES = 5;        // => 6 attempts
    private static final long FETCH_TIMEOUT_MS = 25_000;
    // The Mapbox access token is URL-restricted to the deployed site, so vector
    // tiles and 3D buildings return 403 unless the request carries the site's
    // Origin/Referer (the browser sends these automatically; OkHttp does not).
    private static final String ORIGIN = "https://rontomap.web.app";

    public static final String EXTRA_OP = "op";
    public static final String EXTRA_REGION_ID = "regionId";
    public static final String EXTRA_REGION_JSON = "regionJson";
    public static final String EXTRA_URLS_FILE = "urlsFile";
    public static final String EXTRA_IS_UPDATE = "isUpdate";

    public interface Listener {
        void onEvent(JSONObject ev);
    }

    public static final class ProgressBus {
        private static volatile Listener listener;
        public static void setListener(Listener l) { listener = l; }
        public static void emit(JSONObject ev) {
            Listener l = listener;
            if (l != null) l.onEvent(ev);
        }
    }

    private Thread worker;
    private volatile boolean cancelled = false;
    private OkHttpClient http;

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) { stopSelf(); return START_NOT_STICKY; }
        final String op = intent.getStringExtra(EXTRA_OP);
        final long regionId = intent.getLongExtra(EXTRA_REGION_ID, -1);
        final String regionJson = intent.getStringExtra(EXTRA_REGION_JSON);
        final String urlsFile = intent.getStringExtra(EXTRA_URLS_FILE);
        final boolean isUpdate = intent.getBooleanExtra(EXTRA_IS_UPDATE, false);
        if (op == null || regionJson == null || urlsFile == null || regionId <= 0) {
            Log.w(TAG, "missing extras; stopping");
            stopSelf();
            return START_NOT_STICKY;
        }

        ensureChannel();
        Notification initial = buildNotification("Preparing offline map…", 0, 0, true);
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, initial, 1 /* DATA_SYNC */);
        else startForeground(NOTIFICATION_ID, initial);

        if (worker != null && worker.isAlive()) {
            Log.w(TAG, "tile download already running — refusing concurrent request");
            JSONObject ev = progressEvent("DOWNLOAD_ERROR", regionId, "base".equals(op));
            tryPut(ev, "message", "A download is already in progress.");
            ProgressBus.emit(ev);
            return START_NOT_STICKY;
        }
        cancelled = false;
        worker = new Thread(() -> run(op, regionId, regionJson, urlsFile, isUpdate), "TileDownload-" + regionId);
        worker.start();
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        cancelled = true;
        super.onDestroy();
    }

    private OkHttpClient http() {
        if (http == null) {
            http = new OkHttpClient.Builder()
                    .connectTimeout(15, TimeUnit.SECONDS)
                    .callTimeout(FETCH_TIMEOUT_MS, TimeUnit.MILLISECONDS)
                    .build();
        }
        return http;
    }

    private void run(String op, long regionId, String regionJson, String urlsFile, boolean isUpdate) {
        final boolean isBase = "base".equals(op);
        final TileStore tiles = TileStore.get(this);
        final TileRegionStore regions = TileRegionStore.get(this);
        File urlsTmp = new File(urlsFile);
        try {
            JSONObject region = new JSONObject(regionJson);
            region.put("id", regionId);
            if (isBase) region.put("type", "base");

            // Load the URL list from the temp file.
            List<String> urls = readUrls(urlsTmp);
            final int total = urls.size();

            // Base replace: remove the prior base (tiles + record) first.
            if (isBase) {
                JSONObject prevBase = regions.findBase();
                if (prevBase != null && prevBase.optLong("id", -1) != regionId) {
                    tiles.deleteKeys(regions.tileKeys(prevBase.optLong("id")));
                    regions.delete(prevBase.optLong("id"));
                }
            }

            // Precompute normalized keys (also the record's tileKeys + cleanup list).
            List<String> keys = new ArrayList<>(total);
            for (String u : urls) keys.add(TileStore.normalizeCacheKey(u));

            // Old keys (for update-cancel diff).
            List<String> oldKeys = isUpdate ? regions.tileKeys(regionId) : null;

            // Create/refresh the initial record (mirrors SW dbPut at start).
            if (!isUpdate) {
                region.put("tileKeys", new JSONArray(keys));
                region.put("sizeBytes", 0);
                regions.upsert(region);
            }

            ProgressBus.emit(progress(regionId, 0, total, 0, false, isBase, -1));
            updateNotification("Downloading offline map…", 0, total, total == 0);

            final AtomicInteger idx = new AtomicInteger(0);
            final AtomicInteger done = new AtomicInteger(0);
            final AtomicInteger failed = new AtomicInteger(0);
            final long[] totalSize = {0};
            final Object sizeLock = new Object();

            Runnable workerTask = () -> {
                while (true) {
                    int i = idx.getAndIncrement();
                    if (i >= total || cancelled) return;
                    String url = urls.get(i);
                    String key = keys.get(i);
                    try {
                        if (tiles.has(key)) {
                            File f = tiles.fileForKey(key);
                            synchronized (sizeLock) { totalSize[0] += f.length(); }
                        } else {
                            byte[] bytes = fetchWithRetry(url, key, tiles);
                            if (bytes != null) {
                                synchronized (sizeLock) { totalSize[0] += bytes.length; }
                            } else {
                                failed.incrementAndGet();
                            }
                        }
                    } catch (Exception e) {
                        failed.incrementAndGet();
                    }
                    int d = done.incrementAndGet();
                    if (d % 20 == 0 || d == total) {
                        long sz; synchronized (sizeLock) { sz = totalSize[0]; }
                        ProgressBus.emit(progress(regionId, d, total, failed.get(),
                                d == total && !cancelled, isBase, d == total ? sz : -1));
                        updateNotification("Downloading offline map…", d, total, false);
                    }
                }
            };

            Thread[] pool = new Thread[CONCURRENCY];
            for (int w = 0; w < CONCURRENCY; w++) { pool[w] = new Thread(workerTask, "TileDl-" + w); pool[w].start(); }
            for (Thread t : pool) t.join();

            long finalSize; synchronized (sizeLock) { finalSize = totalSize[0]; }

            if (cancelled) {
                if (isUpdate) {
                    // Purge only newly-fetched keys not referenced by the old record.
                    List<String> oldSet = oldKeys != null ? oldKeys : new ArrayList<>();
                    List<String> toDelete = new ArrayList<>();
                    for (String k : keys) if (!oldSet.contains(k)) toDelete.add(k);
                    tiles.deleteKeys(toDelete);
                } else {
                    tiles.deleteKeys(regions.tileKeys(regionId));
                    regions.delete(regionId);
                }
                ProgressBus.emit(progressEvent("DOWNLOAD_CANCELLED", regionId, isBase));
                updateNotification("Offline map download cancelled", 0, 0, false);
                return;
            }

            // Persist final record.
            region.put("tileKeys", new JSONArray(keys));
            region.put("tileCount", total);
            region.put("sizeBytes", finalSize);
            regions.upsert(region);

            ProgressBus.emit(progress(regionId, total, total, failed.get(), true, isBase, finalSize));
            updateNotification("Offline map ready", 0, 0, false);
        } catch (Throwable t) {
            if (cancelled) {
                ProgressBus.emit(progressEvent("DOWNLOAD_CANCELLED", regionId, isBase));
            } else {
                Log.e(TAG, "tile download failed", t);
                String msg = t.getMessage() != null ? t.getMessage() : t.getClass().getName();
                JSONObject ev = progressEvent("DOWNLOAD_ERROR", regionId, isBase);
                tryPut(ev, "message", msg);
                ProgressBus.emit(ev);
            }
        } finally {
            //noinspection ResultOfMethodCallIgnored
            urlsTmp.delete();
            try { stopForeground(STOP_FOREGROUND_DETACH); } catch (Throwable ignored) {}
            stopSelf();
        }
    }

    /** Returns the body bytes on success (and stores them), or null on permanent failure. */
    private byte[] fetchWithRetry(String url, String key, TileStore tiles) throws Exception {
        Exception last = null;
        int maxAttempts = FETCH_RETRIES + 1;
        for (int attempt = 0; attempt < maxAttempts; attempt++) {
            if (cancelled) return null;
            try {
                Request req = new Request.Builder()
                        .url(url)
                        .header("Origin", ORIGIN)
                        .header("Referer", ORIGIN + "/")
                        .build();
                try (Response resp = http().newCall(req).execute()) {
                    int status = resp.code();
                    ResponseBody body = resp.body();
                    if (resp.isSuccessful() && body != null) {
                        byte[] bytes = body.bytes();
                        String ct = resp.header("Content-Type", "application/octet-stream");
                        tiles.put(key, bytes, ct);
                        return bytes;
                    }
                    last = new Exception("HTTP " + status);
                    // Fail fast on hard client errors (mirror SW): 4xx except 408/429.
                    if (status >= 400 && status < 500 && status != 408 && status != 429) {
                        return null;
                    }
                    String ra = resp.header("Retry-After");
                    if (ra != null && attempt < maxAttempts - 1) {
                        try {
                            long s = Long.parseLong(ra.trim());
                            if (s > 0) { Thread.sleep(Math.min(s * 1000, 30_000)); continue; }
                        } catch (NumberFormatException ignored) { }
                    }
                }
            } catch (Exception e) {
                last = e;
            }
            if (attempt < maxAttempts - 1) {
                long delay = (long) (500 * Math.pow(2, attempt) + Math.random() * 500);
                try { Thread.sleep(delay); } catch (InterruptedException ignored) { }
            }
        }
        if (last != null) throw last;
        return null;
    }

    private static List<String> readUrls(File f) throws Exception {
        byte[] bytes = java.nio.file.Files.readAllBytes(f.toPath());
        JSONArray arr = new JSONArray(new String(bytes, StandardCharsets.UTF_8));
        List<String> urls = new ArrayList<>(arr.length());
        for (int i = 0; i < arr.length(); i++) urls.add(arr.optString(i));
        return urls;
    }

    private static JSONObject progress(long regionId, int done, int total, int failed,
                                       boolean complete, boolean isBase, long sizeBytes) {
        JSONObject ev = new JSONObject();
        try {
            ev.put("type", "DOWNLOAD_PROGRESS");
            ev.put("regionId", regionId);
            ev.put("done", done);
            ev.put("total", total);
            ev.put("failed", failed);
            ev.put("percent", total > 0 ? (done * 100.0 / total) : 100.0);
            ev.put("complete", complete);
            if (isBase) ev.put("isBase", true);
            if (sizeBytes >= 0) ev.put("sizeBytes", sizeBytes);
        } catch (Exception ignored) { }
        return ev;
    }

    private static JSONObject progressEvent(String type, long regionId, boolean isBase) {
        JSONObject ev = new JSONObject();
        try {
            ev.put("type", type);
            ev.put("regionId", regionId);
            if (isBase) ev.put("isBase", true);
        } catch (Exception ignored) { }
        return ev;
    }

    private static void tryPut(JSONObject o, String k, Object v) {
        try { o.put(k, v); } catch (Exception ignored) { }
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, "Offline map download", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("Downloads map tiles for offline use");
        nm.createNotificationChannel(ch);
    }

    private Notification buildNotification(String text, long done, long total, boolean indeterminate) {
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("RontoMap offline maps")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setOngoing(true)
                .setOnlyAlertOnce(true);
        if (total > 0) b.setProgress(100, (int) Math.min(100, (done * 100) / total), indeterminate);
        else b.setProgress(0, 0, indeterminate);
        return b.build();
    }

    private void updateNotification(String text, long done, long total, boolean indeterminate) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIFICATION_ID, buildNotification(text, done, total, indeterminate));
    }
}
