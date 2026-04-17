import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    env: { NODE_ENV: 'test' },
    server: {
      deps: {
        // Prevent Vite from trying to resolve the Firestore SDK during tests.
        // Individual test files that need kvGet/kvPut mock it via vi.mock().
        // Tests that don't need it just need the import to resolve cleanly.
        external: [],
      },
    },
  },
  resolve: {
    alias: {
      // Redirect firestore.js to a lightweight stub so @google-cloud/firestore
      // is never loaded in the test environment.
      '../cloud-run/firestore.js': new URL('./tests/__mocks__/firestore.js', import.meta.url).pathname,
      './firestore.js': new URL('./tests/__mocks__/firestore.js', import.meta.url).pathname,
    },
  },
});
