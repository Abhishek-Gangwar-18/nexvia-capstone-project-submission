import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * API path prefixes. The API has no /api prefix, so in development these are proxied to it as they are.
 * Several are also page URLs (/cart, /orders, /stores, /vendor/*, /admin/*): a page load asks for HTML,
 * so it gets the app (index.html) instead; API calls (JSON, files, the event stream) go to the API.
 */
const API_PATHS = '^/(auth|home|categories|products|stores|coupons|uploads|cart|orders|returns|vendor|admin|payments|health)(?=[/?]|$)';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5180,
    // In development the API is reached through this proxy (same origin), so no CORS setup is needed.
    proxy: {
      [API_PATHS]: {
        target: 'http://localhost:5050',
        changeOrigin: true,
        bypass: (req) => (req.headers.accept?.includes('text/html') ? '/index.html' : undefined),
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          charts: ['recharts'],
          motion: ['framer-motion'],
        },
      },
    },
  },
});
