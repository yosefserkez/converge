import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// CONVERGE_WRANGLER_CONFIG selects the environment config (dev by default).
export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare({ configPath: process.env.CONVERGE_WRANGLER_CONFIG ?? 'wrangler.dev.jsonc' })],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { port: 5173, strictPort: true },
});
