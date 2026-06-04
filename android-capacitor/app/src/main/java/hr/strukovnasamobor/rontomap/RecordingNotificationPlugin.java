package hr.strukovnasamobor.rontomap;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationCompat;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Locale;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * Live path-recording notification with per-second elapsed time + distance.
 *
 * Elapsed time is ticked NATIVELY (a 1s ScheduledExecutorService) so it keeps
 * counting every second even when the app is backgrounded — JS setInterval is
 * throttled in a hidden WebView, but this native thread keeps running while the
 * recording wake-lock / foreground location service keep the process awake.
 *
 * It updates the background-geolocation plugin's foreground-service notification
 * in place (same channel + id 28351), so there's a single notification. JS owns
 * distance (fed via setStats on each location fix) and the lifecycle
 * (start/pause/resume/stop); the bg-geolocation removeWatcher() clears it.
 */
@CapacitorPlugin(name = "RecordingNotification")
public class RecordingNotificationPlugin extends Plugin {

    private static final int BG_GEO_NOTIFICATION_ID = 28351;
    private static final String BG_GEO_CHANNEL_ID =
            "com.equimaps.capacitor_background_geolocation";

    private ScheduledExecutorService ticker;
    private ScheduledFuture<?> tickFuture;

    private volatile long startTimeMs;
    private volatile long pauseAccumulatedMs;
    private volatile long pauseStartMs; // 0 = running, >0 = paused since this time
    private volatile String distanceText = "";
    private volatile String title = "Recording track";
    private volatile boolean running = false;

    @PluginMethod
    public void start(PluginCall call) {
        title = call.getString("title", "Recording track");
        distanceText = call.getString("distanceText", "");
        startTimeMs = System.currentTimeMillis();
        pauseAccumulatedMs = 0;
        pauseStartMs = 0;
        running = true;
        ensureTicker();
        call.resolve();
    }

    @PluginMethod
    public void setStats(PluginCall call) {
        String d = call.getString("distanceText");
        if (d != null) distanceText = d;
        String t = call.getString("title");
        if (t != null) title = t;
        if (running) post();
        call.resolve();
    }

    @PluginMethod
    public void pause(PluginCall call) {
        if (running && pauseStartMs == 0) pauseStartMs = System.currentTimeMillis();
        title = "Recording paused";
        if (running) post();
        call.resolve();
    }

    @PluginMethod
    public void resume(PluginCall call) {
        if (running && pauseStartMs > 0) {
            pauseAccumulatedMs += System.currentTimeMillis() - pauseStartMs;
            pauseStartMs = 0;
        }
        title = "Recording track";
        if (running) post();
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        running = false;
        if (tickFuture != null) { tickFuture.cancel(false); tickFuture = null; }
        call.resolve();
    }

    private synchronized void ensureTicker() {
        if (ticker == null) ticker = Executors.newSingleThreadScheduledExecutor();
        if (tickFuture != null) tickFuture.cancel(false);
        tickFuture = ticker.scheduleAtFixedRate(() -> {
            try { if (running) post(); } catch (Throwable ignored) {}
        }, 0, 1, TimeUnit.SECONDS);
    }

    private long elapsedSec() {
        long now = System.currentTimeMillis();
        long paused = pauseAccumulatedMs + (pauseStartMs > 0 ? now - pauseStartMs : 0);
        return Math.max(0, (now - startTimeMs - paused) / 1000);
    }

    private synchronized void post() {
        Context ctx = getContext();
        if (ctx == null) return;
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && nm.getNotificationChannel(BG_GEO_CHANNEL_ID) == null) {
            NotificationChannel ch = new NotificationChannel(
                    BG_GEO_CHANNEL_ID, "Background Tracking", NotificationManager.IMPORTANCE_DEFAULT);
            ch.enableLights(false);
            ch.enableVibration(false);
            ch.setSound(null, null);
            nm.createNotificationChannel(ch);
        }
        long sec = elapsedSec();
        String time = String.format(Locale.US, "%02d:%02d:%02d",
                sec / 3600, (sec % 3600) / 60, sec % 60);
        String text = (distanceText == null || distanceText.isEmpty())
                ? time : time + "  •  " + distanceText;
        Intent i = new Intent(ctx, MainActivity.class)
                .setAction(Intent.ACTION_MAIN)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(ctx, 0, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n = new NotificationCompat.Builder(ctx, BG_GEO_CHANNEL_ID)
                .setContentTitle(title)
                .setContentText(text)
                .setSmallIcon(ctx.getApplicationInfo().icon)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(pi)
                .build();
        nm.notify(BG_GEO_NOTIFICATION_ID, n);
    }
}
