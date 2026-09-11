import type { AppConfig } from '../config/env.js';
import type { Logger } from '../logging/logger.js';
import { DevIdentityProvider } from './dev-identity-provider.js';
import { OidcIdentityProvider } from './oidc-identity-provider.js';
import type { IdentityProvider } from './types.js';

export function createIdentityProvider(deps: { config: AppConfig; logger: Logger }): IdentityProvider {
  return deps.config.AUTH_MODE === 'dev' ? new DevIdentityProvider(deps.config) : new OidcIdentityProvider(deps);
}
