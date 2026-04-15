package hr.strukovnasamobor.rontomap;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Stub plugin that matches the JS contract for offline routing.
// Full GraphHopper-backed implementation is deferred: each method
// rejects, which causes the JS catch branches to fall back to
// raw-coord polylines without breaking navigation.
@CapacitorPlugin(name = "OfflineRouting")
public class OfflineRoutingPlugin extends Plugin {

    private static final String NOT_AVAILABLE = "Offline routing not available on this build";

    @PluginMethod
    public void downloadRoutingData(PluginCall call) {
        call.reject(NOT_AVAILABLE);
    }

    @PluginMethod
    public void route(PluginCall call) {
        call.reject(NOT_AVAILABLE);
    }

    @PluginMethod
    public void hasRoutingData(PluginCall call) {
        com.getcapacitor.JSObject result = new com.getcapacitor.JSObject();
        result.put("available", false);
        call.resolve(result);
    }

    @PluginMethod
    public void deleteRoutingData(PluginCall call) {
        com.getcapacitor.JSObject result = new com.getcapacitor.JSObject();
        result.put("deleted", true);
        call.resolve(result);
    }
}
