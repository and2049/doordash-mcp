import type { AppConfig } from '../config/env.js';
import { EnvironmentSecretProvider } from './environment-secret-provider.js';
import type { SecretProvider } from './secret-provider.js';

export function createSecretProvider(config: AppConfig): SecretProvider {
  return new EnvironmentSecretProvider(config);
}
