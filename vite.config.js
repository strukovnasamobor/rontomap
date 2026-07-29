import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: "auto",
      includeAssets: [
        "icons/icon-192.png",
        "icons/icon-512.png",
        "icons/icon-512-maskable.png",
      ],
      manifest: {
        id: "hr.strukovnasamobor.rontomap",
        name: 'RontoMap',
        short_name: 'RontoMap',
        theme_color: '#000000',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        scope: "/",
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.js",
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
        drop_console: false, // Set to true in production
        drop_debugger: false, // Set to true in production
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
