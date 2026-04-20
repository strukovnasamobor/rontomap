package hr.strukovnasamobor.rontomap;

import android.content.Intent;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.List;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

@CapacitorPlugin(name = "OfflineRouting")
public class OfflineRoutingPlugin extends Plugin {

    @Override
    public void load() {
        super.load();
        RoutingImportService.ProgressBus.setListener((regionId, phase, done, total, pct, msg) -> {
            JSObject ev = new JSObject();
            ev.put("regionId", regionId);
            ev.put("phase", phase);
            ev.put("bytesDone", done);
            ev.put("bytesTotal", total);
            ev.put("pct", pct);
            if (msg != null) ev.put("message", msg);
            notifyListeners("routingProgress", ev);
        });
    }

    @PluginMethod
    public void downloadRoutingData(PluginCall call) {
        String regionId = call.getString("regionId");
        String pbfUrl = call.getString("pbfUrl");
        if (regionId == null || regionId.isEmpty() || pbfUrl == null || pbfUrl.isEmpty()) {
            call.reject("regionId and pbfUrl are required");
            return;
        }
        Intent i = new Intent(getContext(), RoutingImportService.class);
        i.putExtra(RoutingImportService.EXTRA_REGION_ID, regionId);
        i.putExtra(RoutingImportService.EXTRA_PBF_URL, pbfUrl);
        ContextCompat.startForegroundService(getContext(), i);
        JSObject res = new JSObject();
        res.put("started", true);
        res.put("regionId", regionId);
        call.resolve(res);
    }

    @PluginMethod
    public void route(PluginCall call) {
        String profile = call.getString("profile");
        String waypointsJson = call.getString("waypoints");
        if (profile == null || waypointsJson == null) {
            call.reject("profile and waypoints are required");
            return;
        }
        try {
            JSONArray waypoints = new JSONArray(waypointsJson);
            JSONObject directions = GraphHopperManager.get(getContext()).route(profile, waypoints);
            if (directions == null) {
                call.reject("No offline routing graph covers these waypoints");
                return;
            }
            JSObject res = new JSObject();
            res.put("data", directions.toString());
            call.resolve(res);
        } catch (Exception e) {
            call.reject(e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage(), e);
        }
    }

    @PluginMethod
    public void hasRoutingData(PluginCall call) {
        try {
            List<JSONObject> regions = GraphHopperManager.get(getContext()).listRegions();
            JSONArray arr = new JSONArray();
            for (JSONObject r : regions) arr.put(r);
            JSObject res = new JSObject();
            res.put("available", !regions.isEmpty());
            res.put("regions", arr);
            call.resolve(res);
        } catch (Exception e) {
            call.reject(e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage(), e);
        }
    }

    /**
     * Bypass webview CORS for metadata fetches (Geofabrik index, HEAD size probes).
     * OkHttp runs outside the webview, so cross-origin JSON/HEAD requests are
     * unrestricted. Do NOT use this for the PBF download itself — that path
     * streams through {@link RoutingImportService} so progress is visible.
     */
    @PluginMethod
    public void httpGet(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url is required");
            return;
        }
        new Thread(() -> {
            OkHttpClient client = new OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(60, TimeUnit.SECONDS)
                .build();
            Request req = new Request.Builder().url(url).build();
            try (Response resp = client.newCall(req).execute()) {
                ResponseBody body = resp.body();
                String text = body == null ? "" : body.string();
                JSObject res = new JSObject();
                res.put("ok", resp.isSuccessful());
                res.put("status", resp.code());
                res.put("data", text);
                call.resolve(res);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage(), e);
            }
        }, "OfflineRouting-httpGet").start();
    }

    @PluginMethod
    public void httpHead(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url is required");
            return;
        }
        new Thread(() -> {
            OkHttpClient client = new OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .followRedirects(true)
                .build();
            Request req = new Request.Builder().url(url).head().build();
            try (Response resp = client.newCall(req).execute()) {
                JSObject res = new JSObject();
                res.put("ok", resp.isSuccessful());
                res.put("status", resp.code());
                String cl = resp.header("Content-Length");
                if (cl != null) {
                    try { res.put("contentLength", Long.parseLong(cl)); } catch (NumberFormatException ignored) {}
                }
                call.resolve(res);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage(), e);
            }
        }, "OfflineRouting-httpHead").start();
    }

    @PluginMethod
    public void deleteRoutingData(PluginCall call) {
        String regionId = call.getString("regionId");
        if (regionId == null || regionId.isEmpty()) {
            call.reject("regionId is required");
            return;
        }
        boolean ok = GraphHopperManager.get(getContext()).delete(regionId);
        JSObject res = new JSObject();
        res.put("deleted", ok);
        res.put("regionId", regionId);
        call.resolve(res);
    }
}
