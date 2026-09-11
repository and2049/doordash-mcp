export type ErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'delivery_not_found_or_unavailable'
  | 'integration_not_configured'
  | 'provider_unavailable'
  | 'validation_error'
  | 'rate_limited'
  | 'internal_error';

export const GENERIC_DELIVERY_NOT_FOUND_MESSAGE = 'Delivery not found or not available to this account.';

const HTTP_STATUS_BY_CODE: Record<ErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  delivery_not_found_or_unavailable: 404,
  validation_error: 400,
  rate_limited: 429,
  integration_not_configured: 503,
  provider_unavailable: 503,
  internal_error: 500,
};

export interface AppErrorOptions {
  cause?: unknown;
  expose?: boolean;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly expose: boolean;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = HTTP_STATUS_BY_CODE[code];
    this.expose = options.expose ?? code !== 'internal_error';
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export const Errors = {
  unauthenticated(message = 'Authentication required.'): AppError {
    return new AppError('unauthenticated', message);
  },
  invalidCredentials(): AppError {
    return new AppError('unauthenticated', 'Invalid, expired, or insufficient credentials.');
  },
  forbidden(message = 'You do not have permission to perform this operation.'): AppError {
    return new AppError('forbidden', message);
  },
  deliveryNotFound(): AppError {
    return new AppError('delivery_not_found_or_unavailable', GENERIC_DELIVERY_NOT_FOUND_MESSAGE);
  },
  integrationNotConfigured(): AppError {
    return new AppError('integration_not_configured', 'DoorDash integration is not configured for this account.');
  },
  providerUnavailable(cause?: unknown): AppError {
    return new AppError('provider_unavailable', 'The delivery provider is temporarily unavailable.', { cause });
  },
  validation(message = 'Request validation failed.'): AppError {
    return new AppError('validation_error', message);
  },
  rateLimited(): AppError {
    return new AppError('rate_limited', 'Too many requests. Try again later.');
  },
  internal(cause?: unknown): AppError {
    return new AppError('internal_error', 'An internal error occurred.', { cause, expose: false });
  },
};

export interface SafeErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    request_id: string;
  };
}

export function toSafeErrorResponse(
  error: unknown,
  requestId: string,
): { status: number; body: SafeErrorBody } {
  const appError = isAppError(error) ? error : Errors.internal(error);
  const message = appError.expose ? appError.message : 'An internal error occurred.';
  return {
    status: appError.httpStatus,
    body: {
      error: {
        code: appError.code,
        message,
        request_id: requestId,
      },
    },
  };
}
