package hr.strukovnasamobor.rontomap;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "Fullscreen")
public class FullscreenPlugin extends Plugin {

    @PluginMethod
    public void enter(PluginCall call) {
        MainActivity activity = (MainActivity) getActivity();
        if (activity != null) {
            activity.runOnUiThread(() -> {
                activity.enterFullscreen();
                call.resolve();
            });
        } else {
            call.reject("Activity not available");
        }
    }

    @PluginMethod
    public void exit(PluginCall call) {
        MainActivity activity = (MainActivity) getActivity();
        if (activity != null) {
            activity.runOnUiThread(() -> {
                activity.exitFullscreen();
                call.resolve();
            });
        } else {
            call.reject("Activity not available");
        }
    }
}