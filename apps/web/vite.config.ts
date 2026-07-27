import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // The API container serves this directory as static assets in production
    // (TECHNICAL_DESIGN.md §2); apps/api/src/app.module.ts resolves it.
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    port: 5173,
    // Dev only. In production the SPA and API are same-origin, so session
    // cookies work without any CORS configuration at all.
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
