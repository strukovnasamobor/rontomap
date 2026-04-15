import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: false,
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.js",
      injectManifest: {
        injectionPoint: "self.__WB_MANIFEST",
      },
      includeAssets: [],
    }),
  ],
  test: {
    globals: true,
    environment: "jsdom",
  },
  build: {
    minify: "terser",
    terserOptions: {
      compress: {
        drop_console: true, // Set to true in production
        drop_debugger: true, // Set to true in production
      },
    },
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("react") || id.includes("react-dom") || id.includes("scheduler")) return "react-vendor";
          if (id.includes("firebase")) return "firebase";
          if (id.includes("@ionic")) return "ionic-core";
          if (id.includes("fit-file-parser") || id.includes("fit-parser")) return "fit-parser";
        },
      },
    },
  },
});
