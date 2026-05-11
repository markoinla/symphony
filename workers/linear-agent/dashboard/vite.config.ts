import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Built output is served by the linear-agent Worker as static assets
 * via wrangler's `assets` directive (workers/linear-agent/wrangler.jsonc).
 * `base: "/dashboard/"` makes all generated asset URLs prefix-mounted.
 *
 * Dev: `npm run dev` runs Vite on its own port; configure a proxy in
 * dev wrangler if you want to call the live worker for /api/v1/* from
 * the Vite dev server. For now the simplest dev flow is build →
 * `wrangler dev` of the linear-agent which serves the bundle.
 */
export default defineConfig({
  base: "/dashboard/",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
});
