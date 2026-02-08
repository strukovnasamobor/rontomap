import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate', // Automatically update service worker
      manifest: false,            // Tells plugin to use your existing manifest.json
      includeAssets: [],          // Anything used offline but not referenced in the manifest or code
    }),
  ],
  test: {
    globals: true,
    environment: 'jsdom',
  },
  build: {
    minify: 'terser',
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
          if (!id.includes('node_modules')) return;
          if (
            id.includes('react') ||
            id.includes('react-dom') ||
            id.includes('scheduler')
          ) return 'react-vendor';
          if (id.includes('firebase')) return 'firebase';
          if (id.includes('@ionic')) return 'ionic-core';
        },
      },
    },
  },
});