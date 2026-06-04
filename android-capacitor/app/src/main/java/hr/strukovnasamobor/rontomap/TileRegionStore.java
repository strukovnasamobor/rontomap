package hr.strukovnasamobor.rontomap;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Native mirror of the service worker's IndexedDB "regions" store (src/sw.js).
 * Persisted as a single JSON manifest (filesDir/tiles/regions.json) — the
 * dataset is tiny (a handful of regions), so a manifest beats a DB dependency.
 *
 * Region record fields mirror the SW schema:
 *   id, name, type ("base"|absent), version (base only), north/south/east/west,
 *   minZoom, maxZoom, styleConfigs[], styleIds[], tileCount, sizeBytes,
 *   tileKeys[] (NORMALIZED cache keys — the native analogue of the SW's
 *   tileUrls; kept for direct delete/cancel cleanup), createdAt, updatedAt.
 *
 * tileKeys is stripped before handing regions to JS (parity with the SW
 * stripping tileUrls in GET_REGIONS).
 */
public final class TileRegionStore {

    private static volatile TileRegionStore instance;

    private final File manifestFile;
    private JSONObject manifest; // { nextId: long, regions: [ {..}, .. ] }

    private TileRegionStore(Context ctx) {
        File tilesDir = new File(ctx.getApplicationContext().getFilesDir(), "tiles");
        if (!tilesDir.exists()) tilesDir.mkdirs();
        manifestFile = new File(tilesDir, "regions.json");
        load();
    }

    public static TileRegionStore get(Context ctx) {
        TileRegionStore local = instance;
        if (local == null) {
            synchronized (TileRegionStore.class) {
                local = instance;
                if (local == null) {
                    local = new TileRegionStore(ctx);
                    instance = local;
                }
            }
        }
        return local;
    }

    private synchronized void load() {
        try {
            if (manifestFile.exists()) {
                byte[] bytes = java.nio.file.Files.readAllBytes(manifestFile.toPath());
                manifest = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
            }
        } catch (Exception ignored) { }
        if (manifest == null) manifest = new JSONObject();
        if (!manifest.has("nextId")) try { manifest.put("nextId", 1L); } catch (Exception ignored) { }
        if (!manifest.has("regions")) try { manifest.put("regions", new JSONArray()); } catch (Exception ignored) { }
    }

    private synchronized void persist() {
        try {
            File tmp = new File(manifestFile.getParentFile(), "regions.json.tmp");
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                out.write(manifest.toString().getBytes(StandardCharsets.UTF_8));
            }
            if (!tmp.renameTo(manifestFile)) {
                try (FileOutputStream out = new FileOutputStream(manifestFile)) {
                    out.write(manifest.toString().getBytes(StandardCharsets.UTF_8));
                }
                tmp.delete();
            }
        } catch (Exception ignored) { }
    }

    private JSONArray regionsArray() {
        return manifest.optJSONArray("regions");
    }

    public synchronized long nextId() {
        long id = manifest.optLong("nextId", 1L);
        try { manifest.put("nextId", id + 1); } catch (Exception ignored) { }
        return id;
    }

    /** Insert or replace by id; stamps createdAt/updatedAt. Returns the id. */
    public synchronized long upsert(JSONObject region) {
        try {
            long now = System.currentTimeMillis();
            if (!region.has("id") || region.optLong("id", 0) <= 0) {
                region.put("id", nextId());
            }
            if (!region.has("createdAt")) region.put("createdAt", now);
            region.put("updatedAt", now);
            long id = region.getLong("id");
            JSONArray arr = regionsArray();
            int idx = indexOf(id);
            if (idx >= 0) arr.put(idx, region);
            else arr.put(region);
            persist();
            return id;
        } catch (Exception e) {
            return -1;
        }
    }

    private int indexOf(long id) {
        JSONArray arr = regionsArray();
        for (int i = 0; i < arr.length(); i++) {
            if (arr.optJSONObject(i) != null && arr.optJSONObject(i).optLong("id", -1) == id) return i;
        }
        return -1;
    }

    public synchronized JSONObject get(long id) {
        int idx = indexOf(id);
        return idx >= 0 ? regionsArray().optJSONObject(idx) : null;
    }

    public synchronized JSONObject findBase() {
        JSONArray arr = regionsArray();
        for (int i = 0; i < arr.length(); i++) {
            JSONObject r = arr.optJSONObject(i);
            if (r != null && "base".equals(r.optString("type", null))) return r;
        }
        return null;
    }

    public synchronized void delete(long id) {
        JSONArray arr = regionsArray();
        int idx = indexOf(id);
        if (idx < 0) return;
        arr.remove(idx);
        persist();
    }

    public synchronized void rename(long id, String name) {
        JSONObject r = get(id);
        if (r == null) return;
        try { r.put("name", name); r.put("updatedAt", System.currentTimeMillis()); } catch (Exception ignored) { }
        persist();
    }

    /** Normalized tile keys for a region (for cache cleanup). */
    public synchronized List<String> tileKeys(long id) {
        List<String> keys = new ArrayList<>();
        JSONObject r = get(id);
        if (r == null) return keys;
        JSONArray a = r.optJSONArray("tileKeys");
        if (a == null) return keys;
        for (int i = 0; i < a.length(); i++) keys.add(a.optString(i));
        return keys;
    }

    /** All regions WITHOUT tileKeys — the shape handed to JS (mirrors GET_REGIONS). */
    public synchronized JSONArray getAllStripped() {
        JSONArray out = new JSONArray();
        JSONArray arr = regionsArray();
        for (int i = 0; i < arr.length(); i++) {
            JSONObject r = arr.optJSONObject(i);
            if (r == null) continue;
            JSONObject copy = new JSONObject();
            java.util.Iterator<String> keys = r.keys();
            try {
                while (keys.hasNext()) {
                    String k = keys.next();
                    if (k.equals("tileKeys")) continue;
                    copy.put(k, r.get(k));
                }
            } catch (Exception ignored) { }
            out.put(copy);
        }
        return out;
    }
}
