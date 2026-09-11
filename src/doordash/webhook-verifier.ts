import type { AppConfig } from '../config/env.js';
import { Errors } from '../errors.js';
import type { SecretProvider } from '../secrets/secret-provider.js';
import type { WebhookTokenIssuer, WebhookVerifier } from './types.js';
import { constantTimeEqual, createWebhookTokenIssuer } from './webhook-token.js';

export interface WebhookVerifierDeps {
  config: Pick<AppConfig, 'DOORDASH_WEBHOOK_AUTH_MODE' | 'DOORDASH_WEBHOOK_OAUTH_CLIENT_ID' | 'DOORDASH_WEBHOOK_OAUTH_TOKEN_TTL_SECONDS' | 'mcpIssuerUrl'>;
  secretProvider: Pick<SecretProvider, 'getWebhookVerificationSecret'>;
  clock?: () => Date;
  tokenIssuer?: Pick<WebhookTokenIssuer, 'verify'>;
}

export function createWebhookVerifier(deps: WebhookVerifierDeps): WebhookVerifier {
  const tokenIssuer = deps.tokenIssuer ?? createWebhookTokenIssuer(deps);
  return {
    async verify({ headers }) {
      const values = Object.entries(headers)
        .filter(([key]) => key.toLowerCase() === 'authorization')
        .flatMap(([, value]) => value === undefined ? [] : Array.isArray(value) ? value : [value]);
      const authorization = values.length === 1 ? values[0] : undefined;
      if (deps.config.DOORDASH_WEBHOOK_AUTH_MODE === 'basic') {
        const secret = await deps.secretProvider.getWebhookVerificationSecret();
        if (!secret) throw Errors.integrationNotConfigured();
        if (!constantTimeEqual(authorization ?? '', secret)) throw Errors.invalidCredentials();
        return;
      }
      const match = authorization?.match(/^Bearer ([^\s]+)$/i);
      if (!match?.[1]) throw Errors.invalidCredentials();
      await tokenIssuer.verify(match[1]);
    },
  };
}
