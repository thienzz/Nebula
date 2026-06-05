import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Real-model tests: download + run bge-small on CPU (ONNX). Slower + needs network
// on first run, so these are SEPARATE from the fast overnight gate (test:unit/test:int).
// Run with: npm run test:models
export default defineConfig({
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL('./src/lib', import.meta.url))
    }
  },
  test: {
    name: 'models',
    include: ['tests/models/**/*.{test,spec}.ts'],
    environment: 'node',
    setupFiles: ['tests/models/setup.ts'],
    testTimeout: 180000,
    hookTimeout: 180000
  }
});
