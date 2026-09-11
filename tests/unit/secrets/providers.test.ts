import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../../src/config/env.js';
import { EnvironmentSecretProvider } from '../../../src/secrets/environment-secret-provider.js';
import { CloudSecretProvider } from '../../../src/secrets/cloud-secret-provider.js';
import { createSecretProvider } from '../../../src/secrets/factory.js';

describe('secret providers', () => {
  it('looks up sanitized integration names and falls back', async () => {
    const config = loadEnv({ DOORDASH_SIGNING_SECRET: 'fallback-secret' });
    const provider = new EnvironmentSecretProvider(config, { DOORDASH_SIGNING_SECRET_A_B_C: 'scoped-secret' });
    expect(await provider.getDoorDashSigningSecret('a-b.c')).toBe('scoped-secret');
    expect(await provider.getDoorDashSigningSecret('missing')).toBe('fallback-secret');
    expect(await provider.getDoorDashSigningSecret(null)).toBe('fallback-secret');
    expect(await new EnvironmentSecretProvider(loadEnv({}), {}).getDoorDashSigningSecret(null)).toBeNull();
    expect(createSecretProvider(config)).toBeInstanceOf(EnvironmentSecretProvider);
  });

  it('selects webhook credentials by mode', async () => {
    const config = loadEnv({ DOORDASH_WEBHOOK_BASIC_AUTH: 'basic-secret', DOORDASH_WEBHOOK_OAUTH_CLIENT_SECRET: 'oauth-secret' });
    expect(await new EnvironmentSecretProvider(config).getWebhookVerificationSecret()).toBe('basic-secret');
    expect(await new EnvironmentSecretProvider({ ...config, DOORDASH_WEBHOOK_AUTH_MODE: 'oauth' }).getWebhookVerificationSecret()).toBe('oauth-secret');
    expect(await new EnvironmentSecretProvider(loadEnv({})).getWebhookVerificationSecret()).toBeNull();
  });

  it('parses encryption keys and keeps errors secret-free', async () => {
    const key = Buffer.alloc(32, 7);
    const config = loadEnv({ DATABASE_ENCRYPTION_KEY: key.toString('base64') });
    expect(await new EnvironmentSecretProvider(config).getDatabaseEncryptionKey()).toEqual(key);
    expect(await new EnvironmentSecretProvider(loadEnv({})).getDatabaseEncryptionKey()).toBeNull();
    const invalid = new EnvironmentSecretProvider({ ...config, DATABASE_ENCRYPTION_KEY: 'sensitive-invalid-secret' });
    await expect(invalid.getDatabaseEncryptionKey()).rejects.toThrow('Encryption key must be base64-encoded 32 bytes.');
    await invalid.getDatabaseEncryptionKey().catch((error: unknown) => {
      expect((error as Error).message).not.toContain('sensitive-invalid-secret');
    });
  });

  it('uses injected cloud fetching with logical names', async () => {
    const key = Buffer.alloc(32, 9);
    const secrets: Record<string, string> = {
      DOORDASH_SIGNING_SECRET_A_B: 'scoped', DOORDASH_SIGNING_SECRET: 'fallback',
      DOORDASH_WEBHOOK_BASIC_AUTH: 'basic', DOORDASH_WEBHOOK_OAUTH_CLIENT_SECRET: 'oauth',
      DATABASE_ENCRYPTION_KEY: key.toString('base64'),
    };
    const fetcher = { getSecret: async (name: string): Promise<string | null> => secrets[name] ?? null };
    const config = loadEnv({});
    const provider = new CloudSecretProvider(config, fetcher);
    expect(await provider.getDoorDashSigningSecret('a-b')).toBe('scoped');
    expect(await provider.getDoorDashSigningSecret('missing')).toBe('fallback');
    expect(await provider.getWebhookVerificationSecret()).toBe('basic');
    expect(await provider.getDatabaseEncryptionKey()).toEqual(key);
    expect(await new CloudSecretProvider({ ...config, DOORDASH_WEBHOOK_AUTH_MODE: 'oauth' }, fetcher).getWebhookVerificationSecret()).toBe('oauth');
  });
});
