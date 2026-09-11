import { pino, type Logger } from 'pino';

export type { Logger } from 'pino';

type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export const REDACT_PATHS = [
  'req.headers.authorization',
  'request.headers.authorization',
  'headers.authorization',
  'authorization',
  'req.headers.cookie',
  'headers.cookie',
  'cookie',
  'password',
  'client_secret',
  'clientSecret',
  'signing_secret',
  'signingSecret',
  'webhook_secret',
  'webhookSecret',
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'id_token',
  'idToken',
  'jwt',
  'token',
  'api_key',
  'apiKey',
  '*.authorization',
  '*.cookie',
  '*.password',
  '*.secret',
  '*.token',
] as const;

export interface CreateLoggerOptions {
  level?: LogLevel;
  pretty?: boolean;
  name?: string;
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const base = {
    name: options.name ?? 'doordash-mcp',
    level: options.level ?? (process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info',
    redact: {
      paths: [...REDACT_PATHS],
      censor: '[REDACTED]',
    },
  };

  if (options.pretty) {
    return pino({
      ...base,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard' },
      },
    });
  }

  return pino(base);
}
