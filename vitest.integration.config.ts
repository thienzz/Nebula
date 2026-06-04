import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Integration tests: cross-module flows against fixtures (DB, retrieval),
// still using the InferenceProvider mock — no GPU, no network (overnight-safe).
export default defineConfig({
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL('./src/lib', import.meta.url))
    }
  },
  test: {
    name: 'integration',
    include: ['tests/integration/**/*.{test,spec}.ts'],
    environment: 'node'
  }
});
