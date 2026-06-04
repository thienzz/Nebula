import { defineConfig } from 'vitest/config';

// Integration tests: cross-module flows against fixtures (DB, retrieval),
// still using the InferenceProvider mock — no GPU, no network (overnight-safe).
export default defineConfig({
  test: {
    name: 'integration',
    include: ['tests/integration/**/*.{test,spec}.ts'],
    environment: 'node'
  }
});
