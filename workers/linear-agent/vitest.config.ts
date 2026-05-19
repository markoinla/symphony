import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "dashboard/**",
        "dist/**",
        "migrations/**",
        "test/**",
        "src/db/schema.ts",
      ],
    },
  },
  resolve: {
    alias: {
      // `cloudflare:workers` is a virtual module provided by the Workers
      // runtime — alias it to a local stub so tests can import code that
      // references WorkflowEntrypoint without spinning up the full
      // `@cloudflare/vitest-pool-workers` harness.
      "cloudflare:workers": fileURLToPath(
        new URL("./test/stubs/cloudflare-workers.ts", import.meta.url),
      ),
    },
  },
});
