import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// CE0 bench (`npm run bench`). Synthetic by default (headless, byte-stable results.json); the real
// bge-m3 path (BENCH_REAL=1) downloads the embedder on CPU, so the timeout is generous.
export default defineConfig({
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL('./src/lib', import.meta.url))
    }
  },
  test: {
    name: 'bench',
    include: ['tests/bench/**/*.{test,spec}.ts'],
    environment: 'node',
    testTimeout: 600_000
  }
});
