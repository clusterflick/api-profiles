import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Each test passes its own key (see test/helpers.ts); this only
      // satisfies the required secret.
      miniflare: { bindings: { FIREBASE_SERVICE_ACCOUNT: "{}" } },
    }),
  ],
});
