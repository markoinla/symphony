import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    conditions: ['@tanstack/custom-condition'],
  },
  server: {
    host: true,
    port: 5173,
    allowedHosts: ['home-lab', 'zl-marko-test', 'zenlayer-lp', 'symphony.marko.la'],
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4000',
        changeOrigin: true,
      },
    },
  },
})
