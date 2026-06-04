package hr.strukovnasamobor.rontomap;

import android.content.Context;
import android.util.Log;
import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Collection;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Native counterpart of the service worker's tile cache (src/sw.js).
 *
 * Tiles are downloaded by {@link TileDownloadService} into filesDir/tiles/ and
 * served back to the WebView's Mapbox GL JS by the ServiceWorker request
 * interceptor wired up in {@link MainActivity}. Both the downloader (store) and
 * the interceptor (serve) call {@link #normalizeCacheKey} so equivalent tile
 * URLs (retina @2x, sharded hosts, raster format variants) map to one file.
 *
 * NOTE: byte-for-byte equality with the JS normalizeCacheKey is NOT required —
 * on Android native owns both storing and serving, so only equivalence-class
 * parity (the same collapsing rules) matters. The rules below mirror sw.js.
 */
public final class TileStore {

    private static final String TAG = "TileStore";

    private static volatile TileStore instance;

    private final File tilesDir;

    private TileStore(Context ctx) {
        tilesDir = new File(ctx.getApplicationContext().getFilesDir(), "tiles");
        if (!tilesDir.exists()) tilesDir.mkdirs();
    }

    public static TileStore get(Context ctx) {
        TileStore local = instance;
        if (local == null) {
            synchronized (TileStore.class) {
                local = instance;
                if (local == null) {
                    local = new TileStore(ctx);
                    instance = local;
                }
            }
        }
        return local;
    }

    public File tilesDir() {
        return tilesDir;
    }

    // ---- Mapbox host detection (mirrors sw.js isMapboxHost) ----

    public static boolean isMapboxHost(String host) {
        if (host == null) return false;
        return host.equals("api.mapbox.com")
                || host.equals("events.mapbox.com")
                || host.equals("tiles.mapbox.com")
                || host.endsWith(".tiles.mapbox.com");
    }

    // ---- Cache-key normalization (mirrors sw.js normalizeCacheKey) ----

    private static final Pattern RETINA = Pattern.compile("@[23]x(?=\\.|$)");
    private static final Pattern RASTER = Pattern.compile("(?i)\\.(webp|jpe?g|png)\\d*$");
    private static final Pattern SHARDED_TILES = Pattern.compile("^([a-d]\\.)?tiles\\.mapbox\\.com$");

    /**
     * String-based normalization (no URL re-serialization, to avoid encoding
     * drift). Strips analytics/token query params, collapses @2x/@3x, folds
     * sharded tile hosts onto api.mapbox.com, and collapses raster extensions
     * to .png. Vector (.vector.pbf/.mvt) and model (.glb/.mrt) are untouched.
     */
    public static String normalizeCacheKey(String url) {
        if (url == null) return "";
        try {
            int schemeIdx = url.indexOf("://");
            if (schemeIdx < 0) return url;
            String scheme = url.substring(0, schemeIdx);
            String rest = url.substring(schemeIdx + 3);

            // Drop any fragment.
            int hash = rest.indexOf('#');
            if (hash >= 0) rest = rest.substring(0, hash);

            int slash = rest.indexOf('/');
            String authority = slash < 0 ? rest : rest.substring(0, slash);
            String pathAndQuery = slash < 0 ? "" : rest.substring(slash);

            // Split authority into host[:port].
            String host = authority;
            String portPart = "";
            int colon = authority.indexOf(':');
            if (colon >= 0) {
                host = authority.substring(0, colon);
                portPart = authority.substring(colon); // includes ':'
            }

            // Split path / query.
            String path = pathAndQuery;
            String query = "";
            int q = pathAndQuery.indexOf('?');
            if (q >= 0) {
                path = pathAndQuery.substring(0, q);
                query = pathAndQuery.substring(q + 1);
            }

            // Collapse retina suffix (first match only, like the non-global JS regex).
            path = RETINA.matcher(path).replaceFirst("");
            // Collapse raster format variants onto .png (first match at end).
            path = RASTER.matcher(path).replaceFirst(".png");

            // Strip analytics/token query params; keep the rest verbatim.
            query = stripParams(query);

            // Fold sharded / api tile hosts onto api.mapbox.com.
            String lowerHost = host.toLowerCase(Locale.ROOT);
            if (lowerHost.equals("api.mapbox.com") || SHARDED_TILES.matcher(lowerHost).matches()) {
                host = "api.mapbox.com";
            }

            StringBuilder sb = new StringBuilder();
            sb.append(scheme).append("://").append(host).append(portPart).append(path);
            if (!query.isEmpty()) sb.append('?').append(query);
            return sb.toString();
        } catch (Exception e) {
            return url;
        }
    }

    // Mapbox GL adds session/sdk params at runtime that the download URLs don't
    // carry (notably `sdk=js-3.x` on style/sprite/glyph/TileJSON requests). Drop
    // them so a runtime request normalizes to the same key as the stored tile.
    private static final String[] DROP_PARAMS = {"access_token", "sku", "fresh", "secure", "events", "sdk", "optimize"};

    private static String stripParams(String query) {
        if (query == null || query.isEmpty()) return "";
        String[] parts = query.split("&");
        StringBuilder kept = new StringBuilder();
        for (String part : parts) {
            if (part.isEmpty()) continue;
            int eq = part.indexOf('=');
            String name = eq < 0 ? part : part.substring(0, eq);
            boolean drop = false;
            for (String d : DROP_PARAMS) {
                if (name.equals(d)) { drop = true; break; }
            }
            if (drop) continue;
            if (kept.length() > 0) kept.append('&');
            kept.append(part);
        }
        return kept.toString();
    }

    // ---- File mapping ----

    private static String sha256Hex(String s) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(digest.length * 2);
            for (byte b : digest) {
                hex.append(Character.forDigit((b >> 4) & 0xF, 16));
                hex.append(Character.forDigit(b & 0xF, 16));
            }
            return hex.toString();
        } catch (Exception e) {
            // SHA-256 is always available; fall back to a safe-ish hash.
            return Integer.toHexString(s.hashCode());
        }
    }

    public File fileForKey(String normalizedKey) {
        return new File(tilesDir, sha256Hex(normalizedKey));
    }

    /** For an unnormalized URL (debug/spike logging). */
    public File fileForUrl(String url) {
        return fileForKey(normalizeCacheKey(url));
    }

    public boolean has(String normalizedKey) {
        return fileForKey(normalizedKey).exists();
    }

    // ---- Read / write ----

    /** Atomically store a tile body + its content type (sidecar ".ct" file). */
    public void put(String normalizedKey, byte[] body, String contentType) throws IOException {
        File target = fileForKey(normalizedKey);
        File tmp = new File(tilesDir, target.getName() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(body);
        }
        if (!tmp.renameTo(target)) {
            // renameTo can fail across some FS states; fall back to copy.
            try (FileOutputStream out = new FileOutputStream(target)) {
                out.write(body);
            }
            tmp.delete();
        }
        if (contentType != null && !contentType.isEmpty()) {
            try (FileOutputStream ct = new FileOutputStream(new File(tilesDir, target.getName() + ".ct"))) {
                ct.write(contentType.getBytes(StandardCharsets.UTF_8));
            } catch (IOException ignored) { /* content-type is best-effort */ }
        }
    }

    /**
     * Build a WebResourceResponse for a (raw) URL if its tile is stored, else
     * null so the caller lets the request proceed normally.
     */
    public WebResourceResponse responseForUrl(String url) {
        String key = normalizeCacheKey(url);
        File f = fileForKey(key);
        if (!f.exists()) return null;
        try {
            String mime = contentTypeFor(f, key);
            Map<String, String> headers = new HashMap<>();
            headers.put("Access-Control-Allow-Origin", "*");
            headers.put("Cache-Control", "public, max-age=31536000");
            InputStream in = new FileInputStream(f);
            WebResourceResponse resp = new WebResourceResponse(mime, null, 200, "OK", headers, in);
            return resp;
        } catch (Exception e) {
            Log.w(TAG, "responseForUrl failed for " + url + ": " + e.getMessage());
            return null;
        }
    }

    private String contentTypeFor(File tileFile, String normalizedKey) {
        // Prefer the stored content type from the download.
        File ct = new File(tilesDir, tileFile.getName() + ".ct");
        if (ct.exists()) {
            try (FileInputStream in = new FileInputStream(ct)) {
                byte[] buf = new byte[256];
                int n = in.read(buf);
                if (n > 0) return new String(buf, 0, n, StandardCharsets.UTF_8).trim();
            } catch (IOException ignored) { }
        }
        // Otherwise infer from the normalized path extension.
        String path = normalizedKey.toLowerCase(Locale.ROOT);
        int q = path.indexOf('?');
        if (q >= 0) path = path.substring(0, q);
        if (path.endsWith(".png")) return "image/png";
        if (path.endsWith(".json")) return "application/json";
        if (path.endsWith(".webp")) return "image/webp";
        if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
        if (path.endsWith(".pbf") || path.endsWith(".mvt")) return "application/x-protobuf";
        return "application/octet-stream";
    }

    // ---- Deletion ----

    public void deleteKeys(Collection<String> normalizedKeys) {
        if (normalizedKeys == null) return;
        for (String key : normalizedKeys) {
            File f = fileForKey(key);
            //noinspection ResultOfMethodCallIgnored
            f.delete();
            //noinspection ResultOfMethodCallIgnored
            new File(tilesDir, f.getName() + ".ct").delete();
        }
    }

    public void deleteAll() {
        File[] files = tilesDir.listFiles();
        if (files == null) return;
        for (File f : files) {
            // Keep regions.json (the metadata manifest) — only remove tiles + sidecars.
            if (f.getName().equals("regions.json")) continue;
            //noinspection ResultOfMethodCallIgnored
            f.delete();
        }
    }
}
