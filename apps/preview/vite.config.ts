import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare({ configPath: process.env.CONVERGE_WRANGLER_CONFIG ?? 'wrangler.dev.jsonc' })],
  server: { port: 8790, strictPort: true },
});
