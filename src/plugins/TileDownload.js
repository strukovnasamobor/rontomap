import { registerPlugin } from "@capacitor/core";

// Native (Android) offline map-tile downloader. On web these are never called
// — the service worker handles tile downloads instead (see src/sw.js). The web
// stubs exist only so imports resolve.
const TileDownload = registerPlugin("TileDownload", {
  web: () => ({
    async downloadRegion() {
      throw new Error("TileDownload is only available on native Android");
    },
    async downloadBaseMap() {
      throw new Error("TileDownload is only available on native Android");
    },
    async cancel() {
      return { cancelled: false };
    },
    async getRegions() {
      return { regions: [] };
    },
    async deleteRegion() {
      return { deleted: false };
    },
    async deleteBase() {
      return { deletedBase: false };
    },
    async renameRegion() {
      return {};
    },
    async addListener() {
      return { remove: async () => {} };
    },
  }),
});

export default TileDownload;
