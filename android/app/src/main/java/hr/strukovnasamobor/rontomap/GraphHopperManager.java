package hr.strukovnasamobor.rontomap;

import android.content.Context;
import android.util.Log;

import com.graphhopper.GHRequest;
import com.graphhopper.GHResponse;
import com.graphhopper.GraphHopper;
import com.graphhopper.ResponsePath;
import com.graphhopper.config.CHProfile;
import com.graphhopper.config.Profile;
import com.graphhopper.util.PointList;
import com.graphhopper.util.shapes.BBox;
import com.graphhopper.util.shapes.GHPoint;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class GraphHopperManager {

    private static final String TAG = "GraphHopperManager";
    private static final String GRAPH_DIR_NAME = "graphhopper";

    private static GraphHopperManager INSTANCE;

    public static synchronized GraphHopperManager get(Context context) {
        if (INSTANCE == null) INSTANCE = new GraphHopperManager(context.getApplicationContext());
        return INSTANCE;
    }

    private final Context appContext;
    private final Map<String, GraphHopper> loaded = new HashMap<>();

    private GraphHopperManager(Context context) {
        this.appContext = context;
    }

    public File graphRoot() {
        File root = new File(appContext.getFilesDir(), GRAPH_DIR_NAME);
        if (!root.exists()) root.mkdirs();
        return root;
    }

    public File graphDirFor(String regionId) {
        return new File(graphRoot(), sanitize(regionId));
    }

    /** Translate Mapbox profile name to GraphHopper profile name. */
    public static String mapboxToGh(String profile) {
        if (profile == null) return "car";
        switch (profile) {
            case "walking": return "foot";
            case "cycling": return "bike";
            case "driving": return "car";
            default: return profile;
        }
    }

    /** Build a new GraphHopper configured with car/bike/foot profiles, no CH flags set yet. */
    public GraphHopper newConfigured(File graphDir, String osmFile) {
        GraphHopper hopper = new GraphHopper();
        if (osmFile != null) hopper.setOSMFile(osmFile);
        hopper.setGraphHopperLocation(graphDir.getAbsolutePath());
        hopper.setProfiles(Arrays.asList(
            new Profile("car").setVehicle("car").setWeighting("fastest").setTurnCosts(false),
            new Profile("bike").setVehicle("bike").setWeighting("fastest").setTurnCosts(false),
            new Profile("foot").setVehicle("foot").setWeighting("fastest").setTurnCosts(false)
        ));
        // Contraction Hierarchies give us fast queries on device. Prepared on import.
        hopper.getCHPreparationHandler().setCHProfiles(
            new CHProfile("car"),
            new CHProfile("bike"),
            new CHProfile("foot")
        );
        return hopper;
    }

    /** Lazy-load a graph for an existing regionId. Returns null if the directory is missing. */
    public synchronized GraphHopper loadIfExists(String regionId) {
        String key = sanitize(regionId);
        GraphHopper cached = loaded.get(key);
        if (cached != null) return cached;
        File dir = graphDirFor(key);
        if (!dir.exists() || !new File(dir, "properties").exists()) return null;
        GraphHopper hopper = newConfigured(dir, null);
        hopper.importOrLoad();
        loaded.put(key, hopper);
        return hopper;
    }

    public synchronized void registerLoaded(String regionId, GraphHopper hopper) {
        loaded.put(sanitize(regionId), hopper);
    }

    public synchronized void unload(String regionId) {
        String key = sanitize(regionId);
        GraphHopper gh = loaded.remove(key);
        if (gh != null) {
            try { gh.close(); } catch (Exception ignored) {}
        }
    }

    public synchronized boolean delete(String regionId) {
        unload(regionId);
        File dir = graphDirFor(regionId);
        return deleteRecursive(dir);
    }

    /** Scan the graph root for already-imported regions (each subfolder with a 'properties' file). */
    public synchronized List<JSONObject> listRegions() {
        List<JSONObject> out = new ArrayList<>();
        File root = graphRoot();
        File[] children = root.listFiles();
        if (children == null) return out;
        for (File child : children) {
            if (!child.isDirectory()) continue;
            File props = new File(child, "properties");
            if (!props.exists()) continue;
            JSONObject info = new JSONObject();
            try {
                info.put("id", child.getName());
                info.put("sizeBytes", sizeOf(child));
                info.put("profiles", new JSONArray(new String[]{"car", "bike", "foot"}));
                // Prefer the `properties` file mtime — it's written at the end of
                // a successful import, so reflects the graph's age rather than any
                // later touch to the folder.
                long ts = props.lastModified();
                if (ts <= 0) ts = child.lastModified();
                info.put("updatedAt", ts);
                GraphHopper gh = loadIfExists(child.getName());
                if (gh != null) {
                    BBox b = gh.getBaseGraph().getBounds();
                    JSONObject bbox = new JSONObject();
                    bbox.put("west", b.minLon);
                    bbox.put("south", b.minLat);
                    bbox.put("east", b.maxLon);
                    bbox.put("north", b.maxLat);
                    info.put("bbox", bbox);
                }
                out.add(info);
            } catch (Exception e) {
                Log.w(TAG, "failed to describe region " + child.getName(), e);
            }
        }
        return out;
    }

    /**
     * Route across the loaded graphs. Picks the first graph whose bbox contains every waypoint.
     * Returns a Mapbox-Directions-v5-shaped JSON object, or null if no graph covers the query.
     */
    public synchronized JSONObject route(String mapboxProfile, JSONArray waypoints) throws Exception {
        String ghProfile = mapboxToGh(mapboxProfile);
        List<GHPoint> points = new ArrayList<>();
        for (int i = 0; i < waypoints.length(); i++) {
            JSONObject wp = waypoints.getJSONObject(i);
            points.add(new GHPoint(wp.getDouble("lat"), wp.getDouble("lng")));
        }
        if (points.size() < 2) return null;

        // Load any region folders that exist but aren't loaded yet (lazy cache warm-up).
        for (File child : safeListFiles(graphRoot())) {
            if (child.isDirectory() && new File(child, "properties").exists()) {
                loadIfExists(child.getName());
            }
        }

        for (Map.Entry<String, GraphHopper> entry : loaded.entrySet()) {
            GraphHopper gh = entry.getValue();
            BBox bounds = gh.getBaseGraph().getBounds();
            if (!allInside(bounds, points)) continue;

            GHRequest req = new GHRequest(points).setProfile(ghProfile);
            GHResponse rsp = gh.route(req);
            if (rsp.hasErrors()) {
                Log.w(TAG, "route errors on region " + entry.getKey() + ": " + rsp.getErrors());
                continue;
            }
            ResponsePath best = rsp.getBest();
            return toMapboxDirections(best);
        }
        return null;
    }

    private static boolean allInside(BBox bbox, List<GHPoint> points) {
        for (GHPoint p : points) {
            if (p.lon < bbox.minLon || p.lon > bbox.maxLon ||
                p.lat < bbox.minLat || p.lat > bbox.maxLat) return false;
        }
        return true;
    }

    private static JSONObject toMapboxDirections(ResponsePath path) throws Exception {
        PointList pl = path.getPoints();
        JSONArray coords = new JSONArray();
        for (int i = 0; i < pl.size(); i++) {
            JSONArray c = new JSONArray();
            c.put(pl.getLon(i));
            c.put(pl.getLat(i));
            coords.put(c);
        }
        JSONObject geometry = new JSONObject();
        geometry.put("type", "LineString");
        geometry.put("coordinates", coords);

        JSONObject route = new JSONObject();
        route.put("geometry", geometry);
        route.put("distance", path.getDistance());
        route.put("duration", path.getTime() / 1000.0);

        JSONObject out = new JSONObject();
        out.put("routes", new JSONArray().put(route));
        out.put("code", "Ok");
        return out;
    }

    private static File[] safeListFiles(File dir) {
        File[] f = dir.listFiles();
        return f == null ? new File[0] : f;
    }

    private static long sizeOf(File f) {
        if (f.isFile()) return f.length();
        long total = 0;
        File[] children = f.listFiles();
        if (children == null) return 0;
        for (File c : children) total += sizeOf(c);
        return total;
    }

    private static boolean deleteRecursive(File f) {
        if (!f.exists()) return true;
        if (f.isDirectory()) {
            File[] children = f.listFiles();
            if (children != null) for (File c : children) deleteRecursive(c);
        }
        return f.delete();
    }

    private static String sanitize(String id) {
        if (id == null) return "default";
        return id.replaceAll("[^A-Za-z0-9_.-]", "_");
    }
}
