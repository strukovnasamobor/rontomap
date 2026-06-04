import { registerPlugin } from "@capacitor/core";

// Updates the live "recording" notification (the background-location foreground
// service notification) with elapsed time + distance while a path is recording.
// Native-only; no-op on web.
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
