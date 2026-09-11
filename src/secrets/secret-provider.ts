export interface SecretProvider {
  getDoorDashSigningSecret(integrationId: string | null): Promise<string | null>;
  getWebhookVerificationSecret(): Promise<string | null>;
  getDatabaseEncryptionKey(): Promise<Buffer | null>;
}

export class MissingSecretError extends Error {
  constructor(secretName: string) {
    super(`Required secret is not available: ${secretName}`);
    this.name = 'MissingSecretError';
  }
}
