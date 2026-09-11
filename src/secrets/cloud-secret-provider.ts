import type { AppConfig } from '../config/env.js';
import { parseEncryptionKey } from '../crypto/field-crypto.js';
import { signingSecretEnvName } from './environment-secret-provider.js';
import type { SecretProvider } from './secret-provider.js';

export interface SecretFetcher {
  getSecret(name: string): Promise<string | null>;
}

export class CloudSecretProvider implements SecretProvider {
  constructor(private readonly config: AppConfig, private readonly fetcher: SecretFetcher) {}

  // TODO: Map logical names in SecretFetcher adapters for AWS Secrets Manager, GCP Secret Manager, Azure Key Vault, and HashiCorp Vault.
  async getDoorDashSigningSecret(integrationId: string | null): Promise<string | null> {
    const scoped = integrationId ? await this.fetcher.getSecret(signingSecretEnvName(integrationId)) : null;
    return scoped || this.fetcher.getSecret('DOORDASH_SIGNING_SECRET');
  }

  async getWebhookVerificationSecret(): Promise<string | null> {
    return this.fetcher.getSecret(this.config.DOORDASH_WEBHOOK_AUTH_MODE === 'basic'
      ? 'DOORDASH_WEBHOOK_BASIC_AUTH' : 'DOORDASH_WEBHOOK_OAUTH_CLIENT_SECRET');
  }

  async getDatabaseEncryptionKey(): Promise<Buffer | null> {
    return parseEncryptionKey(await this.fetcher.getSecret('DATABASE_ENCRYPTION_KEY'));
  }
}
