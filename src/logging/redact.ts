const SENSITIVE_KEY_PATTERN =
  /(secret|token|authorization|cookie|password|signature|jwt|credential|api[-_]?key|phone|address|coordinate|latitude|longitude|location|dasher|driver)/i;

const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

const AUTH_SCHEME_PATTERN = /\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/gi;

const MAX_STRING_LENGTH = 512;

function redactString(value: string): string {
  let result = value.replace(JWT_PATTERN, '[REDACTED_JWT]');
  result = result.replace(AUTH_SCHEME_PATTERN, '$1 [REDACTED]');
  if (result.length > MAX_STRING_LENGTH) {
    result = `${result.slice(0, MAX_STRING_LENGTH)}...[truncated]`;
  }
  return result;
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[TRUNCATED]';
  if (typeof value === 'string') return redactString(value);
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : redactValue(nested, depth + 1);
    }
    return result;
  }
  return value;
}

export function sanitizeAuditMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const sanitized = redactValue(metadata);
  return typeof sanitized === 'object' && sanitized !== null && !Array.isArray(sanitized)
    ? (sanitized as Record<string, unknown>)
    : {};
}
