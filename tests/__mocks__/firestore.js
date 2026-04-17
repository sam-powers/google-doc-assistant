// Lightweight stub used by vitest.config.js alias to prevent @google-cloud/firestore
// from being loaded during tests. Individual test files that need to assert on
// kvGet/kvPut/kvDelete behavior use vi.mock('../cloud-run/firestore.js') directly,
// which overrides this stub with their own mocks.
export const kvGet = async () => null;
export const kvPut = async () => undefined;
export const kvDelete = async () => undefined;
