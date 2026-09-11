import { createHash, hkdfSync, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { AppConfig } from '../config/env.js';
import { Errors } from '../errors.js';
import type { SecretProvider } from '../secrets/secret-provider.js';
import type { WebhookTokenIssuer } from './types.js';

export function constantTimeEqual(left: string, right: string): boolean {
  return timingSafeEqual(createHash('sha256').update(left).digest(), createHash('sha256').update(right).digest());
}

export interface WebhookTokenIssuerDeps {
  config: Pick<AppConfig, 'DOORDASH_WEBHOOK_OAUTH_CLIENT_ID' | 'DOORDASH_WEBHOOK_OAUTH_TOKEN_TTL_SECONDS' | 'mcpIssuerUrl'>;
  secretProvider: Pick<SecretProvider, 'getWebhookVerificationSecret'>;
  clock?: () => Date;
}

function deriveKey(secret: string): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', secret, '', 'doordash-webhook-token', 32));
}

export function createWebhookTokenIssuer({ config, secretProvider, clock = () => new Date() }: WebhookTokenIssuerDeps): WebhookTokenIssuer {
  return {
    async issue({ clientId, clientSecret }) {
      const secret = await secretProvider.getWebhookVerificationSecret();
      const idMatches = constantTimeEqual(clientId, config.DOORDASH_WEBHOOK_OAUTH_CLIENT_ID ?? '');
      const secretMatches = constantTimeEqual(clientSecret, secret ?? '');
      if (!config.DOORDASH_WEBHOOK_OAUTH_CLIENT_ID || !secret || !idMatches || !secretMatches) {
        throw Errors.invalidCredentials();
      }
      const now = Math.floor(clock().getTime() / 1000);
      const accessToken = await new SignJWT({})
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuer(config.mcpIssuerUrl)
        .setAudience('doordash-webhooks')
        .setSubject(clientId)
        .setIssuedAt(now)
        .setExpirationTime(now + config.DOORDASH_WEBHOOK_OAUTH_TOKEN_TTL_SECONDS)
        .sign(deriveKey(secret));
      return { access_token: accessToken, token_type: 'Bearer', expires_in: config.DOORDASH_WEBHOOK_OAUTH_TOKEN_TTL_SECONDS };
    },
    async verify(token) {
      try {
        const secret = await secretProvider.getWebhookVerificationSecret();
        if (!secret || !config.DOORDASH_WEBHOOK_OAUTH_CLIENT_ID) throw Errors.invalidCredentials();
        await jwtVerify(token, deriveKey(secret), {
          algorithms: ['HS256'],
          issuer: config.mcpIssuerUrl,
          audience: 'doordash-webhooks',
          subject: config.DOORDASH_WEBHOOK_OAUTH_CLIENT_ID,
          requiredClaims: ['iat', 'exp'],
          currentDate: clock(),
        });
      } catch {
        throw Errors.invalidCredentials();
      }
    },
  };
}
