package hr.strukovnasamobor.rontomap;

import android.content.Context;
import android.content.Intent;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * Capacitor bridge for native offline map-tile downloads (Android).
 * Mirrors OfflineRoutingPlugin: starts {@link TileDownloadService} as a
 * foreground service and forwards its progress to JS via notifyListeners.
 * On web, the service worker handles this instead (see src/sw.js); JS only
 * calls this plugin when running natively on Android.
 */
@CapacitorPlugin(name = "TileDownload")
public class TileDownloadPlugin extends Plugin {

    @Override
    public void load() {
        super.load();
        TileDownloadService.ProgressBus.setListener(ev -> {
            try {
                notifyListeners("tileProgress", new JSObject(ev.toString()));
            } catch (Exception ignored) { }
        });
    }

    @PluginMethod
    public void downloadRegion(PluginCall call) {
        startDownload(call, "region");
    }

    @PluginMethod
    public void downloadBaseMap(PluginCall call) {
        startDownload(call, "base");
    }

    private void startDownload(PluginCall call, String op) {
        JSObject region = call.getObject("region");
        JSArray tileUrls = call.getArray("tileUrls");
        boolean isUpdate = Boolean.TRUE.equals(call.getBoolean("isUpdate", false));
        if (region == null || tileUrls == null) {
            call.reject("region and tileUrls are required");
            return;
        }
        Context ctx = getContext();
        // POST_NOTIFICATIONS is requested app-wide in MainActivity.onCreate.
        try {
            long regionId = region.has("id") ? region.getLong("id") : 0;
            if (regionId <= 0) regionId = TileRegionStore.get(ctx).nextId();
            region.put("id", regionId);

            // The URL list can be large — pass it via a temp file, not the Intent
            // (Binder transactions are capped ~1 MB).
            File dir = new File(ctx.getCacheDir(), "tileurls");
            if (!dir.exists()) dir.mkdirs();
            File urlsFile = new File(dir, "urls-" + regionId + ".json");
            try (FileOutputStream out = new FileOutputStream(urlsFile)) {
                out.write(tileUrls.toString().getBytes(StandardCharsets.UTF_8));
            }

            Intent i = new Intent(ctx, TileDownloadService.class);
            i.putExtra(TileDownloadService.EXTRA_OP, op);
            i.putExtra(TileDownloadService.EXTRA_REGION_ID, regionId);
            i.putExtra(TileDownloadService.EXTRA_REGION_JSON, region.toString());
            i.putExtra(TileDownloadService.EXTRA_URLS_FILE, urlsFile.getAbsolutePath());
            i.putExtra(TileDownloadService.EXTRA_IS_UPDATE, isUpdate);
            ContextCompat.startForegroundService(ctx, i);

            JSObject res = new JSObject();
            res.put("started", true);
            res.put("regionId", regionId);
            call.resolve(res);
        } catch (Exception e) {
            call.reject(e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage(), e);
        }
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        getContext().stopService(new Intent(getContext(), TileDownloadService.class));
        JSObject res = new JSObject();
        res.put("cancelled", true);
        call.resolve(res);
    }

    @PluginMethod
    public void getRegions(PluginCall call) {
        try {
            JSONArray regions = TileRegionStore.get(getContext()).getAllStripped();
            JSObject res = new JSObject();
            res.put("regions", regions);
            call.resolve(res);
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    @PluginMethod
    public void deleteRegion(PluginCall call) {
        Long regionId = call.getLong("regionId");
        if (regionId == null) { call.reject("regionId required"); return; }
        Context ctx = getContext();
        TileRegionStore regions = TileRegionStore.get(ctx);
        List<String> keys = regions.tileKeys(regionId);
        TileStore.get(ctx).deleteKeys(keys);
        regions.delete(regionId);
        JSObject res = new JSObject();
        res.put("deleted", true);
        res.put("regionId", regionId);
        call.resolve(res);
    }

    @PluginMethod
    public void deleteBase(PluginCall call) {
        // Mirror the SW handleDeleteBase: cascade — remove every region + all tiles.
        Context ctx = getContext();
        TileRegionStore regions = TileRegionStore.get(ctx);
        try {
            JSONArray all = regions.getAllStripped();
            for (int i = 0; i < all.length(); i++) {
                long id = all.optJSONObject(i).optLong("id", -1);
                if (id > 0) regions.delete(id);
            }
        } catch (Exception ignored) { }
        TileStore.get(ctx).deleteAll();
        JSObject res = new JSObject();
        res.put("deletedBase", true);
        call.resolve(res);
    }

    @PluginMethod
    public void renameRegion(PluginCall call) {
        Long regionId = call.getLong("regionId");
        String name = call.getString("name");
        if (regionId == null || name == null) { call.reject("regionId and name required"); return; }
        TileRegionStore.get(getContext()).rename(regionId, name);
        JSObject res = new JSObject();
        res.put("regionId", regionId);
        res.put("name", name);
        call.resolve(res);
    }
}
