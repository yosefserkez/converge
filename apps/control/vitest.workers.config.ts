import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Coordinator tests in the real Workers runtime (Miniflare). The test config has
// no containers and no Artifacts, so nothing here needs Docker or the network.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.test.jsonc' },
      miniflare: {
        bindings: {
          PREVIEW_SIGNING_KEY: 'test-preview-signing-key-0123456789abcdef',
          ANTHROPIC_API_KEY: '',
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
