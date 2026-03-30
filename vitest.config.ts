import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/*/src/**/*.spec.ts', 'packages/*/src/**/*.spec.ts', 'scripts/**/*.spec.ts'],
    globals: false,
    environment: 'node',
    testTimeout: 10000,
  },
});
