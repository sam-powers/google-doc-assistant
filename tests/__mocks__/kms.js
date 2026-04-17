// Lightweight stub used by vitest.config.js alias to prevent @google-cloud/kms
// from being loaded during tests. The real encrypt/decrypt helpers in index.js
// short-circuit to a pass-through when KMS_KEY_NAME is unset, so this stub only
// needs to export a constructor that doesn't throw.
export class KeyManagementServiceClient {
  async encrypt({ plaintext }) {
    return [{ ciphertext: plaintext }];
  }
  async decrypt({ ciphertext }) {
    return [{ plaintext: ciphertext }];
  }
}
