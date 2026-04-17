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
      // Redirect @google-cloud/kms to a stub — KMS_KEY_NAME is unset in tests,
      // so encrypt/decrypt pass-through anyway, but the import must resolve.
      '@google-cloud/kms': new URL('./tests/__mocks__/kms.js', import.meta.url).pathname,
    },
  },
});
