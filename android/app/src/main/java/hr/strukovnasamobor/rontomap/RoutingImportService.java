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

import com.graphhopper.GraphHopper;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * Foreground service that downloads an OSM PBF and runs the GraphHopper import.
 *
 * Intent extras:
 *   "regionId" : String   — folder name under filesDir/graphhopper/
 *   "pbfUrl"   : String   — HTTPS URL of the PBF to download
 *
 * Progress is published through {@link ProgressBus} so OfflineRoutingPlugin
 * can forward it to JS via notifyListeners.
 */
public class RoutingImportService extends Service {

    private static final String TAG = "RoutingImportService";
    private static final String CHANNEL_ID = "rontomap_routing_import";
    private static final int NOTIFICATION_ID = 4711;

    public static final String EXTRA_REGION_ID = "regionId";
    public static final String EXTRA_PBF_URL = "pbfUrl";

    public interface ProgressListener {
        void onProgress(String regionId, String phase, long bytesDone, long bytesTotal, int pct, String message);
    }

    public static final class ProgressBus {
        private static volatile ProgressListener listener;

        public static void setListener(ProgressListener l) { listener = l; }

        public static void emit(String regionId, String phase, long done, long total, int pct, String message) {
            ProgressListener l = listener;
            if (l != null) l.onProgress(regionId, phase, done, total, pct, message);
        }
    }

    private Thread worker;
    private volatile boolean cancelled = false;

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) { stopSelf(); return START_NOT_STICKY; }
        final String regionId = intent.getStringExtra(EXTRA_REGION_ID);
        final String pbfUrl = intent.getStringExtra(EXTRA_PBF_URL);
        if (regionId == null || pbfUrl == null) {
            Log.w(TAG, "missing extras; stopping");
            stopSelf();
            return START_NOT_STICKY;
        }

        ensureChannel();
        Notification initial = buildNotification("Preparing " + regionId + "…", 0, 0, true);
        int typeFlag = 0;
        if (Build.VERSION.SDK_INT >= 29) {
            // FOREGROUND_SERVICE_TYPE_DATA_SYNC = 1
            typeFlag = 1;
        }
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, initial, typeFlag);
        } else {
            startForeground(NOTIFICATION_ID, initial);
        }

        if (worker != null && worker.isAlive()) {
            Log.w(TAG, "import already running — ignoring new request for " + regionId);
            return START_NOT_STICKY;
        }
        worker = new Thread(() -> runImport(regionId, pbfUrl), "RoutingImport-" + regionId);
        worker.start();
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        cancelled = true;
        super.onDestroy();
    }

    private void runImport(String regionId, String pbfUrl) {
        File pbfFile = null;
        try {
            File cacheDir = new File(getCacheDir(), "pbf");
            if (!cacheDir.exists()) cacheDir.mkdirs();
            pbfFile = new File(cacheDir, regionId + ".osm.pbf");

            downloadPbf(regionId, pbfUrl, pbfFile);
            if (cancelled) { cleanup(pbfFile); return; }

            importGraph(regionId, pbfFile);
            if (cancelled) { cleanup(pbfFile); return; }

            cleanup(pbfFile);
            ProgressBus.emit(regionId, "done", 0, 0, 100, "Routing data ready");
            updateNotification("Routing data ready: " + regionId, 0, 0, false);
        } catch (OutOfMemoryError oom) {
            Log.e(TAG, "OOM during import for " + regionId, oom);
            ProgressBus.emit(regionId, "error", 0, 0, 0,
                "Out of memory — region too large for this device. Try a smaller PBF.");
            updateNotification("Routing import failed (OOM): " + regionId, 0, 0, false);
        } catch (Throwable t) {
            // Catch Throwable (not just Exception) so Errors like NoClassDefFoundError /
            // UnsatisfiedLinkError are surfaced to the UI instead of killing the process.
            Log.e(TAG, "import failed for " + regionId, t);
            String msg = t.getMessage();
            if (msg == null || msg.isEmpty()) msg = t.getClass().getName();
            // Include the first stack frame so the user can copy something actionable.
            StackTraceElement[] st = t.getStackTrace();
            if (st != null && st.length > 0) msg = msg + " @ " + st[0].toString();
            ProgressBus.emit(regionId, "error", 0, 0, 0, msg);
            updateNotification("Routing import failed: " + regionId, 0, 0, false);
        } finally {
            try { stopForeground(STOP_FOREGROUND_DETACH); } catch (Throwable ignored) {}
            stopSelf();
        }
    }

    private void downloadPbf(String regionId, String url, File target) throws Exception {
        ProgressBus.emit(regionId, "downloading", 0, 0, 0, "Starting download");
        updateNotification("Downloading " + regionId + "…", 0, 0, true);

        OkHttpClient client = new OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(120, TimeUnit.SECONDS)
            .callTimeout(60, TimeUnit.MINUTES)
            .build();

        Request req = new Request.Builder().url(url).build();
        try (Response resp = client.newCall(req).execute()) {
            if (!resp.isSuccessful()) throw new RuntimeException("HTTP " + resp.code() + " for " + url);
            ResponseBody body = resp.body();
            if (body == null) throw new RuntimeException("empty body");

            long total = body.contentLength();
            long done = 0;
            long lastEmit = 0;
            byte[] buf = new byte[64 * 1024];

            try (InputStream in = body.byteStream();
                 OutputStream out = new FileOutputStream(target)) {
                int n;
                while ((n = in.read(buf)) != -1) {
                    if (cancelled) throw new RuntimeException("Cancelled");
                    out.write(buf, 0, n);
                    done += n;
                    long now = System.currentTimeMillis();
                    if (now - lastEmit > 500) {
                        lastEmit = now;
                        int pct = total > 0 ? (int) ((done * 100) / total) : -1;
                        ProgressBus.emit(regionId, "downloading", done, total, pct, null);
                        updateNotification("Downloading " + regionId, done, total, false);
                    }
                }
            }
        }
        ProgressBus.emit(regionId, "downloading", target.length(), target.length(), 100, "Download complete");
    }

    private void importGraph(String regionId, File pbfFile) {
        ProgressBus.emit(regionId, "importing", 0, 0, -1, "Building routing graph… 0s elapsed");
        updateNotification("Importing " + regionId + "… (this can take a while)", 0, 0, true);

        GraphHopperManager manager = GraphHopperManager.get(getApplicationContext());
        // Unload any in-memory instance so importOrLoad can recreate the folder.
        manager.unload(regionId);
        File graphDir = manager.graphDirFor(regionId);
        if (graphDir.exists()) {
            deleteRecursive(graphDir);
        }
        graphDir.mkdirs();

        // GraphHopper's importOrLoad() runs for many minutes on a country-sized
        // PBF without emitting progress. Run a heartbeat alongside it so the UI
        // shows elapsed time ticking rather than a stuck 0%.
        final long startMs = System.currentTimeMillis();
        final Thread heartbeat = new Thread(() -> {
            try {
                while (!Thread.currentThread().isInterrupted()) {
                    Thread.sleep(3000);
                    long elapsedSec = (System.currentTimeMillis() - startMs) / 1000;
                    String text = "Building routing graph… " + formatElapsed(elapsedSec) + " elapsed";
                    ProgressBus.emit(regionId, "importing", 0, 0, -1, text);
                    updateNotification("Importing " + regionId + " (" + formatElapsed(elapsedSec) + ")", 0, 0, true);
                }
            } catch (InterruptedException ignored) {}
        }, "RoutingImport-heartbeat-" + regionId);
        heartbeat.setDaemon(true);
        heartbeat.start();

        try {
            GraphHopper hopper = manager.newConfigured(graphDir, pbfFile.getAbsolutePath());
            hopper.importOrLoad();
            manager.registerLoaded(regionId, hopper);
        } finally {
            heartbeat.interrupt();
        }
    }

    private static String formatElapsed(long sec) {
        if (sec < 60) return sec + "s";
        long m = sec / 60;
        long s = sec % 60;
        return m + "m " + s + "s";
    }

    private void cleanup(File pbfFile) {
        if (pbfFile != null && pbfFile.exists()) {
            if (!pbfFile.delete()) Log.w(TAG, "could not delete temp PBF " + pbfFile);
        }
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel existing = nm.getNotificationChannel(CHANNEL_ID);
        if (existing != null) return;
        NotificationChannel ch = new NotificationChannel(
            CHANNEL_ID, "Offline routing import", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("Downloads routing data for offline navigation");
        nm.createNotificationChannel(ch);
    }

    private Notification buildNotification(String text, long done, long total, boolean indeterminate) {
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("RontoMap offline routing")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setOngoing(true)
            .setOnlyAlertOnce(true);
        if (total > 0) {
            int pct = (int) Math.min(100, (done * 100) / total);
            b.setProgress(100, pct, indeterminate);
        } else {
            b.setProgress(0, 0, indeterminate);
        }
        return b.build();
    }

    private void updateNotification(String text, long done, long total, boolean indeterminate) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        nm.notify(NOTIFICATION_ID, buildNotification(text, done, total, indeterminate));
    }

    private static void deleteRecursive(File f) {
        if (!f.exists()) return;
        if (f.isDirectory()) {
            File[] children = f.listFiles();
            if (children != null) for (File c : children) deleteRecursive(c);
        }
        f.delete();
    }
}
