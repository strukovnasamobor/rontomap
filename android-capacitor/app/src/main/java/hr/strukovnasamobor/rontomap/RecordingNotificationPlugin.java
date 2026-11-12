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
 * Live activity notifications with per-second elapsed time + distance.
 *
 * Two independent slots, so a path recording and a navigation/trace can run at
 * the same time and each keep their own notification, clock and distance:
 *
 *  - "recording" (the default) replaces the background-geolocation plugin's
 *    foreground-service notification in place (same channel + id 28351), so a
 *    recording shows a single notification. Its removeWatcher() clears it.
 *  - "route" (navigation and path tracing) normally a plain ongoing notification
 *    of its own, with no service behind it, so JS passes clear=true to stop().
 *    But a route can also run with no recording alongside it, and then it is the
 *    route that holds the background watcher and its foreground service. Rather
 *    than show the service's notification plus its own, it takes the service's
 *    over in place exactly as a recording does, on JS's say-so (own / the
 *    ownService method). Ownership moves back and forth as recordings start and
 *    stop under a running route, so the service is never left without one.
 *
 * Elapsed time is ticked NATIVELY (a 1s ScheduledExecutorService) so it keeps
 * counting every second even when the app is backgrounded — JS setInterval is
 * throttled in a hidden WebView, but this native thread keeps running while the
 * recording wake-lock / foreground location service keep the process awake.
 *
 * JS owns distance (fed via setStats on each location fix), the titles, and the
 * lifecycle (start/pause/resume/stop). Every call picks its slot by name.
 */
@CapacitorPlugin(name = "RecordingNotification")
public class RecordingNotificationPlugin extends Plugin {

    private static final String BG_GEO_CHANNEL_ID =
            "com.equimaps.capacitor_background_geolocation";
    private static final int RECORDING_NOTIFICATION_ID = 28351;
    private static final int ROUTE_NOTIFICATION_ID = 28352;

    /** One live notification: its clock, pause accounting, texts and ticker. */
    private static final class Slot {
        final int notificationId;
        ScheduledFuture<?> tickFuture;
        volatile long startTimeMs;
        volatile long pauseAccumulatedMs;
        volatile long pauseStartMs; // 0 = running, >0 = paused since this time
        volatile String distanceText = "";
        volatile String title = "";
        volatile boolean running = false;
        // True when this slot has taken over the background-geolocation
        // service's notification instead of posting its own.
        volatile boolean ownsService = false;

        Slot(int notificationId) { this.notificationId = notificationId; }

        /** The id this slot currently posts to. */
        int activeId() {
            return ownsService ? RECORDING_NOTIFICATION_ID : notificationId;
        }

        long elapsedSec() {
            long now = System.currentTimeMillis();
            long paused = pauseAccumulatedMs + (pauseStartMs > 0 ? now - pauseStartMs : 0);
            return Math.max(0, (now - startTimeMs - paused) / 1000);
        }
    }

    private final Slot recording = new Slot(RECORDING_NOTIFICATION_ID);
    private final Slot route = new Slot(ROUTE_NOTIFICATION_ID);
    private ScheduledExecutorService ticker;

    private Slot slotFor(PluginCall call) {
        return "route".equals(call.getString("slot", "recording")) ? route : recording;
    }

    private Slot other(Slot s) {
        return s == recording ? route : recording;
    }

    private boolean isLiveOn(Slot s, int notificationId) {
        return s.running && s.activeId() == notificationId;
    }

    private void cancel(int notificationId) {
        Context ctx = getContext();
        NotificationManager nm = ctx == null ? null
                : (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(notificationId);
    }

    /**
     * Move a slot on or off the service's notification, clearing the id it
     * leaves so the handover never shows two. The recording slot already posts
     * to the service's id, so for it this is a no-op.
     */
    private void setOwnsService(Slot s, boolean own) {
        synchronized (s) {
            if (s == recording || s.ownsService == own) return;
            int vacated = s.activeId();
            s.ownsService = own;
            // Only clear the id being left if nothing else is showing there. The
            // service's own id is handed over while the service is still running,
            // and cancelling it out from under a live foreground service would
            // leave it without the notification Android requires it to have.
            if (vacated != s.activeId() && !isLiveOn(other(s), vacated)) cancel(vacated);
            post(s);
        }
    }

    /** Hand the service's notification to this slot, or take it back. */
    @PluginMethod
    public void ownService(PluginCall call) {
        setOwnsService(slotFor(call), Boolean.TRUE.equals(call.getBoolean("own", false)));
        call.resolve();
    }

    @PluginMethod
    public void start(PluginCall call) {
        Slot s = slotFor(call);
        setOwnsService(s, Boolean.TRUE.equals(call.getBoolean("own", false)));
        synchronized (s) {
            s.title = call.getString("title", "Recording track");
            s.distanceText = call.getString("distanceText", "");
            s.startTimeMs = System.currentTimeMillis();
            s.pauseAccumulatedMs = 0;
            s.pauseStartMs = 0;
            s.running = true;
            ensureTicker(s);
        }
        call.resolve();
    }

    @PluginMethod
    public void setStats(PluginCall call) {
        Slot s = slotFor(call);
        String d = call.getString("distanceText");
        if (d != null) s.distanceText = d;
        String t = call.getString("title");
        if (t != null) s.title = t;
        post(s);
        call.resolve();
    }

    @PluginMethod
    public void pause(PluginCall call) {
        Slot s = slotFor(call);
        if (s.running && s.pauseStartMs == 0) s.pauseStartMs = System.currentTimeMillis();
        s.title = call.getString("title", "Recording paused");
        post(s);
        call.resolve();
    }

    @PluginMethod
    public void resume(PluginCall call) {
        Slot s = slotFor(call);
        if (call.hasOption("own")) {
            setOwnsService(s, Boolean.TRUE.equals(call.getBoolean("own", false)));
        }
        if (s.running && s.pauseStartMs > 0) {
            s.pauseAccumulatedMs += System.currentTimeMillis() - s.pauseStartMs;
            s.pauseStartMs = 0;
        }
        s.title = call.getString("title", "Recording track");
        post(s);
        call.resolve();
    }

    // Locked on the slot like post(): a tick already posting finishes first, and
    // a tick arriving later sees running=false, so a cleared notification cannot
    // be put straight back.
    @PluginMethod
    public void stop(PluginCall call) {
        Slot s = slotFor(call);
        synchronized (s) {
            s.running = false;
            if (s.tickFuture != null) { s.tickFuture.cancel(false); s.tickFuture = null; }
            // The route slot has no service behind it, so without this the
            // notification would outlive the trip it reports on. A recording's
            // is taken down by its foreground service with the watcher; JS
            // clears it afterwards anyway, for anything that slipped through.
            if (Boolean.TRUE.equals(call.getBoolean("clear", false))) {
                Context ctx = getContext();
                NotificationManager nm = ctx == null ? null
                        : (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm != null) nm.cancel(s.activeId());
                // Nothing of this slot is on screen any more, so it holds no
                // claim on the service's notification either.
                s.ownsService = false;
            }
        }
        call.resolve();
    }

    private synchronized void ensureTicker(Slot s) {
        if (ticker == null) ticker = Executors.newSingleThreadScheduledExecutor();
        if (s.tickFuture != null) s.tickFuture.cancel(false);
        s.tickFuture = ticker.scheduleAtFixedRate(() -> {
            try { post(s); } catch (Throwable ignored) {}
        }, 0, 1, TimeUnit.SECONDS);
    }

    private void post(Slot s) {
        synchronized (s) {
            if (!s.running) return;
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
            long sec = s.elapsedSec();
            String time = String.format(Locale.US, "%02d:%02d", sec / 3600, (sec % 3600) / 60);
            String text = (s.distanceText == null || s.distanceText.isEmpty())
                    ? time : time + "  •  " + s.distanceText;
            Intent i = new Intent(ctx, MainActivity.class)
                    .setAction(Intent.ACTION_MAIN)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent pi = PendingIntent.getActivity(ctx, 0, i,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Notification n = new NotificationCompat.Builder(ctx, BG_GEO_CHANNEL_ID)
                    .setContentTitle(s.title)
                    .setContentText(text)
                    .setSmallIcon(ctx.getApplicationInfo().icon)
                    .setOngoing(true)
                    .setOnlyAlertOnce(true)
                    .setContentIntent(pi)
                    .build();
            nm.notify(s.activeId(), n);
        }
    }
}
