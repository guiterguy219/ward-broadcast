import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "cloudflare:workers": fileURLToPath(new URL("./test/cloudflare-workers-stub.ts", import.meta.url)) },
  },
  test: {
    // Bundle the OAuth library through Vite so the alias above applies to its imports.
    server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
  },
});
