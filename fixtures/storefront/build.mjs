// Protected build script: bundles the HTTP server and the browser client.
import { build } from 'esbuild';

const common = {
  bundle: true,
  jsx: 'automatic',
  logLevel: 'warning',
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
};

await build({
  ...common,
  entryPoints: ['src/server.ts'],
  outfile: 'dist/server.mjs',
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // CommonJS dependencies bundled into ESM still call require() for built-ins.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});

await build({
  ...common,
  entryPoints: ['src/client.tsx'],
  outfile: 'dist/client.js',
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  minify: true,
});
