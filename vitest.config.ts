import { defineConfig } from 'vitest/config';

// Unit tests: co-located in src/**, plus tests/unit/**. No GPU, no network.
// Integration tests live in tests/integration and run via vitest.integration.config.ts.
export default defineConfig({
  test: {
    name: 'unit',
    include: ['src/**/*.{test,spec}.ts', 'tests/unit/**/*.{test,spec}.ts'],
    environment: 'node'
  }
});
