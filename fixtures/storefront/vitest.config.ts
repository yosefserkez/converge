import { defineConfig } from 'vitest/config';

// Local developer feedback only. Protected acceptance checks run outside this
// project, over HTTP, in the Converge verification harness.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node',
  },
});
