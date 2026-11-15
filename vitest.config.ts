import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { defineConfig } from "vitest/config";

/**
 * A service account made up for the tests. Generated here rather than in a
 * test, because the Durable Objects read Firestore with the key in their own
 * bindings, which a test can't replace; the public half lets a test check
 * what it signed.
 */
const { publicKey, privateKey } = await generateKeyPair("RS256", {
  extractable: true,
});
const SERVICE_ACCOUNT = JSON.stringify({
  type: "service_account",
  client_email: "profiles@clusterflick-com.iam.gserviceaccount.com",
  private_key: await exportPKCS8(privateKey),
  private_key_id: "test-key",
});

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          FIREBASE_SERVICE_ACCOUNT: SERVICE_ACCOUNT,
          PURGE_SECRET: "test-purge-secret",
          TEST_SERVICE_ACCOUNT_PUBLIC_JWK: JSON.stringify(
            await exportJWK(publicKey),
          ),
        },
      },
    }),
  ],
});
