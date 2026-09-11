import { SignJWT } from 'jose';
import type { AppConfig } from '../config/env.js';
import { Errors } from '../errors.js';
import type { SecretProvider } from '../secrets/secret-provider.js';
import type { DoorDashJwtProvider } from './types.js';

const MAX_TTL_SECONDS = 1800;
const DEFAULT_TTL_SECONDS = 900;
const REFRESH_MARGIN_SECONDS = 60;

export interface DoorDashJwtProviderDeps {
  config: Pick<AppConfig, 'DOORDASH_DEVELOPER_ID' | 'DOORDASH_KEY_ID'>;
  secretProvider: Pick<SecretProvider, 'getDoorDashSigningSecret'>;
  clock?: () => Date;
  ttlSeconds?: number;
}

interface CachedToken {
  token: string;
  expiresAtSeconds: number;
}

export function decodeSigningSecret(secret: string): Uint8Array {
  const decoded = Buffer.from(secret, 'base64');
  return decoded.length > 0 ? new Uint8Array(decoded) : new Uint8Array(Buffer.from(secret, 'utf8'));
}

export function createDoorDashJwtProvider(deps: DoorDashJwtProviderDeps): DoorDashJwtProvider {
  const clock = deps.clock ?? (() => new Date());
  const requestedTtl = deps.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const ttlSeconds = Number.isFinite(requestedTtl)
    ? Math.max(1, Math.min(Math.floor(requestedTtl), MAX_TTL_SECONDS))
    : DEFAULT_TTL_SECONDS;
  const cache = new Map<string | null, CachedToken>();

  async function mint(integrationId: string | null, nowSeconds: number): Promise<CachedToken> {
    const developerId = deps.config.DOORDASH_DEVELOPER_ID;
    const keyId = deps.config.DOORDASH_KEY_ID;
    const secret = await deps.secretProvider.getDoorDashSigningSecret(integrationId);
    if (!developerId || !keyId || !secret) {
      throw Errors.integrationNotConfigured();
    }
    const expiresAtSeconds = nowSeconds + ttlSeconds;
    const token = await new SignJWT({ aud: 'doordash', iss: developerId, kid: keyId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT', 'dd-ver': 'DD-JWT-V1' })
      .setIssuedAt(nowSeconds)
      .setExpirationTime(expiresAtSeconds)
      .sign(decodeSigningSecret(secret));
    return { token, expiresAtSeconds };
  }

  return {
    async getToken(options = {}) {
      const integrationId = options.integrationId ?? null;
      const nowSeconds = Math.floor(clock().getTime() / 1000);
      const cached = cache.get(integrationId);
      if (cached && cached.expiresAtSeconds - nowSeconds >= REFRESH_MARGIN_SECONDS) {
        return cached.token;
      }
      const fresh = await mint(integrationId, nowSeconds);
      cache.set(integrationId, fresh);
      return fresh.token;
    },
  };
}
