import { z } from 'zod';
import { AppError } from '../errors.js';

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  MCP_TRANSPORT: z.enum(['http', 'stdio']).default('http'),
  DATABASE_URL: z.string().min(1).optional(),
  PGLITE_DATA_DIR: z.string().min(1).default('.data/pglite'),
  AUTH_MODE: z.enum(['dev', 'oidc']).default('dev'),
  MCP_ISSUER_URL: z.string().min(1).optional(),
  MCP_RESOURCE_URL: z.string().min(1).optional(),
  OIDC_ISSUER_URL: z.string().min(1).optional(),
  OIDC_AUDIENCE: z.string().min(1).optional(),
  OIDC_TENANT_CLAIM: z.string().min(1).default('tenant_id'),
  OIDC_SUBJECT_CLAIM: z.string().min(1).default('sub'),
  OIDC_SCOPE_CLAIM: z.string().min(1).default('scope'),
  DEV_TENANT_ID: z.uuid().default('00000000-0000-4000-8000-000000000001'),
  DEV_TENANT_NAME: z.string().min(1).default('Development Tenant'),
  DEV_USER_ID: z.string().min(1).default('dev-user'),
  DOORDASH_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
  DOORDASH_DEVELOPER_ID: z.string().min(1).optional(),
  DOORDASH_KEY_ID: z.string().min(1).optional(),
  DOORDASH_SIGNING_SECRET: z.string().min(1).optional(),
  DOORDASH_API_BASE_URL: z.string().min(1).optional(),
  DOORDASH_API_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  DOORDASH_API_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  DOORDASH_WEBHOOK_AUTH_MODE: z.enum(['basic', 'oauth']).default('basic'),
  DOORDASH_WEBHOOK_BASIC_AUTH: z.string().min(1).optional(),
  DOORDASH_WEBHOOK_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  DOORDASH_WEBHOOK_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  DOORDASH_WEBHOOK_OAUTH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().max(3600).default(300),
  DOORDASH_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(86_400),
  DATABASE_ENCRYPTION_KEY: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  RATE_LIMIT_TOOL_PER_MINUTE: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_WEBHOOK_PER_MINUTE: z.coerce.number().int().positive().default(600),
  STATUS_DELAYED_AFTER_SECONDS: z.coerce.number().int().positive().default(180),
  STATUS_STALE_AFTER_SECONDS: z.coerce.number().int().positive().default(900),
  RECENT_DELIVERED_WINDOW_HOURS: z.coerce.number().int().positive().default(24),
});

export type Env = z.infer<typeof EnvSchema>;

export interface AppConfig extends Env {
  isProduction: boolean;
  isTest: boolean;
  isDevelopment: boolean;
  mcpIssuerUrl: string;
  mcpResourceUrl: string;
  databaseDriver: 'pg' | 'pglite';
}

function validateEncryptionKey(value: string | undefined): string | null {
  if (!value) return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 32 ? null : 'must be a base64-encoded 32-byte key';
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.superRefine((env, ctx) => {
    const add = (path: string, message: string): void => {
      ctx.addIssue({ code: 'custom', path: [path], message });
    };

    if (env.AUTH_MODE === 'oidc') {
      if (!env.OIDC_ISSUER_URL) add('OIDC_ISSUER_URL', 'required when AUTH_MODE=oidc');
      if (!env.OIDC_AUDIENCE) add('OIDC_AUDIENCE', 'required when AUTH_MODE=oidc');
    }
    if (env.DOORDASH_WEBHOOK_AUTH_MODE === 'oauth') {
      if (!env.DOORDASH_WEBHOOK_OAUTH_CLIENT_ID) add('DOORDASH_WEBHOOK_OAUTH_CLIENT_ID', 'required when DOORDASH_WEBHOOK_AUTH_MODE=oauth');
      if (!env.DOORDASH_WEBHOOK_OAUTH_CLIENT_SECRET) add('DOORDASH_WEBHOOK_OAUTH_CLIENT_SECRET', 'required when DOORDASH_WEBHOOK_AUTH_MODE=oauth');
    }

    const keyError = validateEncryptionKey(env.DATABASE_ENCRYPTION_KEY);
    if (keyError) add('DATABASE_ENCRYPTION_KEY', keyError);

    if (env.NODE_ENV === 'production') {
      if (env.AUTH_MODE !== 'oidc') add('AUTH_MODE', 'must be "oidc" in production');
      for (const key of ['DATABASE_URL', 'OIDC_ISSUER_URL', 'OIDC_AUDIENCE', 'DOORDASH_DEVELOPER_ID', 'DOORDASH_KEY_ID', 'DOORDASH_SIGNING_SECRET', 'DATABASE_ENCRYPTION_KEY'] as const) {
        if (!env[key]) add(key, 'required in production');
      }
      if (env.DOORDASH_WEBHOOK_AUTH_MODE === 'basic' && !env.DOORDASH_WEBHOOK_BASIC_AUTH) {
        add('DOORDASH_WEBHOOK_BASIC_AUTH', 'required in production when DOORDASH_WEBHOOK_AUTH_MODE=basic');
      }
    }
  }).safeParse(source);

  if (!parsed.success) {
    const paths = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || 'environment'))].sort();
    throw new AppError('validation_error', `Invalid environment configuration: ${paths.join(', ')}`);
  }

  const env = parsed.data;
  const hostForUrl = env.HOST === '0.0.0.0' ? '127.0.0.1' : env.HOST;
  const mcpIssuerUrl = env.MCP_ISSUER_URL ?? `http://${hostForUrl}:${env.PORT}`;

  return {
    ...env,
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    isDevelopment: env.NODE_ENV === 'development',
    mcpIssuerUrl,
    mcpResourceUrl: env.MCP_RESOURCE_URL ?? `${mcpIssuerUrl}/mcp`,
    databaseDriver: env.DATABASE_URL ? 'pg' : 'pglite',
  };
}
