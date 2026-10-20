import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each test file gets its own throwaway database (see test/helpers.ts).
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
