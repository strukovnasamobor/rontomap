import { registerPlugin } from "@capacitor/core";

// Live activity notifications with elapsed time + distance. Two independent
// slots: "recording" (the default — the background-location foreground service
// notification, updated in place) and "route" (navigation and path tracing,
// a notification of its own), so both can run at once. Native-only; no-op on
// web.
const RecordingNotification = registerPlugin("RecordingNotification", {
  web: () => ({
    async start() {},
    async setStats() {},
    async pause() {},
    async resume() {},
    async stop() {},
  }),
});

export default RecordingNotification;
