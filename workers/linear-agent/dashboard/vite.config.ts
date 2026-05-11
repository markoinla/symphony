import path from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Linear-agent Worker mounts the SPA at `/dashboard/*` and serves built
// assets via the ASSETS binding (see ../src/routes/dashboard.ts). The build
// output therefore needs to live under `dist/dashboard/` so the wrangler
// asset config (workers/linear-agent/wrangler.jsonc) picks it up.
//
// In dev (`npm run dev`), `/dashboard/api/*` and `/oauth/*` are proxied to
// the local wrangler dev server on 127.0.0.1:8787.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/dashboard/',
  resolve: {
    conditions: ['@tanstack/custom-condition'],
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'dist/dashboard',
    emptyOutDir: true,
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/dashboard/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
      '/oauth': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
})
