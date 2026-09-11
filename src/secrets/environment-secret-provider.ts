import type { AppConfig } from '../config/env.js';
import { parseEncryptionKey } from '../crypto/field-crypto.js';
import type { SecretProvider } from './secret-provider.js';

export function signingSecretEnvName(integrationId: string): string {
  const sanitized = integrationId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return `DOORDASH_SIGNING_SECRET_${sanitized}`;
}

export class EnvironmentSecretProvider implements SecretProvider {
  constructor(
    private readonly config: AppConfig,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async getDoorDashSigningSecret(integrationId: string | null): Promise<string | null> {
    if (integrationId) {
      const scoped = this.env[signingSecretEnvName(integrationId)];
      if (scoped) return scoped;
    }
    return this.config.DOORDASH_SIGNING_SECRET ?? null;
  }

  async getWebhookVerificationSecret(): Promise<string | null> {
    const secret =
      this.config.DOORDASH_WEBHOOK_AUTH_MODE === 'basic'
        ? this.config.DOORDASH_WEBHOOK_BASIC_AUTH
        : this.config.DOORDASH_WEBHOOK_OAUTH_CLIENT_SECRET;
    return secret ?? null;
  }

  async getDatabaseEncryptionKey(): Promise<Buffer | null> {
    return parseEncryptionKey(this.config.DATABASE_ENCRYPTION_KEY);
  }
}
