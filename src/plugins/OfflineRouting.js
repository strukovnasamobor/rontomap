import { registerPlugin } from "@capacitor/core";

const OfflineRouting = registerPlugin("OfflineRouting", {
  web: () => ({
    async downloadRoutingData() {
      throw new Error("Offline routing is only available on Android");
    },
    async route() {
      throw new Error("Offline routing is only available on Android");
    },
    async hasRoutingData() {
      return { available: false, regions: [] };
    },
    async deleteRoutingData() {
      return { deleted: false };
    },
    async httpGet({ url }) {
      const res = await fetch(url);
      return { ok: res.ok, status: res.status, data: await res.text() };
    },
    async httpHead({ url }) {
      const res = await fetch(url, { method: "HEAD" });
      const cl = res.headers.get("content-length");
      return { ok: res.ok, status: res.status, contentLength: cl ? Number(cl) : undefined };
    },
    async addListener() {
      return { remove: async () => {} };
    },
  }),
});

export default OfflineRouting;
