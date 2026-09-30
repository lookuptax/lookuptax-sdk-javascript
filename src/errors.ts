/**
 * The API separates two kinds of failure, and so does this SDK:
 *
 *  - A **request error** (HTTP 4xx/5xx) means the call could not be processed:
 *    authentication, quota, rate limit, a malformed request. These THROW.
 *  - A **validation outcome** (HTTP 200) means the call succeeded but the tax
 *    ID itself is invalid or could not be confirmed. These RETURN, and you read
 *    `result.status`.
 *
 * Mixing the two is the most common integration mistake: an INVALID tax ID is
 * a successful call, not an error.
 */
export class LookupTaxError extends Error {
  /** Stable machine-readable code, e.g. `quota_exceeded`. Branch on this, never on `message`. */
  readonly code: string;
  readonly status: number;
  /** Seconds to wait, from the `Retry-After` header. Only set for 429. */
  readonly retryAfter?: number;
  readonly body?: unknown;

  constructor(args: {
    code: string;
    status: number;
    message: string;
    retryAfter?: number;
    body?: unknown;
  }) {
    super(args.message);
    this.name = "LookupTaxError";
    this.code = args.code;
    this.status = args.status;
    this.retryAfter = args.retryAfter;
    this.body = args.body;
    Object.setPrototypeOf(this, LookupTaxError.prototype);
  }

  /**
   * Whether retrying the identical request could plausibly succeed.
   * 429 (rate limited — retries do not consume quota), 500 and 503 only.
   */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 500 || this.status === 503;
  }
}

/** The API key is missing, malformed, revoked or expired. */
export class AuthenticationError extends LookupTaxError {
  constructor(a: ConstructorParameters<typeof LookupTaxError>[0]) {
    super(a);
    this.name = "AuthenticationError";
    Object.setPrototypeOf(this, AuthenticationError.prototype);
  }
}

/** Monthly validation quota is exhausted, or the batch could not be reserved. */
export class QuotaExceededError extends LookupTaxError {
  constructor(a: ConstructorParameters<typeof LookupTaxError>[0]) {
    super(a);
    this.name = "QuotaExceededError";
    Object.setPrototypeOf(this, QuotaExceededError.prototype);
  }
}

/** Too many requests per second. Back off for `retryAfter` seconds. */
export class RateLimitError extends LookupTaxError {
  constructor(a: ConstructorParameters<typeof LookupTaxError>[0]) {
    super(a);
    this.name = "RateLimitError";
    Object.setPrototypeOf(this, RateLimitError.prototype);
  }
}

/** A required parameter is missing or malformed. */
export class InvalidRequestError extends LookupTaxError {
  constructor(a: ConstructorParameters<typeof LookupTaxError>[0]) {
    super(a);
    this.name = "InvalidRequestError";
    Object.setPrototypeOf(this, InvalidRequestError.prototype);
  }
}

/** No batch or tax ID exists with that identifier. */
export class NotFoundError extends LookupTaxError {
  constructor(a: ConstructorParameters<typeof LookupTaxError>[0]) {
    super(a);
    this.name = "NotFoundError";
    Object.setPrototypeOf(this, NotFoundError.prototype);
  }
}

/**
 * Map an HTTP failure onto the most specific error class.
 *
 * Note 422 is deliberately NOT an error here — the body still carries a
 * `result` with status UNSUPPORTED, so the caller reads it like any other
 * outcome. The client handles that before reaching this function.
 */
export function errorFromResponse(status: number, body: any, retryAfter?: number): LookupTaxError {
  const code: string = body?.error ?? body?.code ?? `http_${status}`;
  const message: string = body?.message ?? `Request failed with HTTP ${status}`;
  const args = { code, status, message, retryAfter, body };

  if (status === 401) return new AuthenticationError(args);
  if (status === 403) return new AuthenticationError(args);
  if (status === 402) return new QuotaExceededError(args);
  if (status === 429) return new RateLimitError(args);
  if (status === 404) return new NotFoundError(args);
  if (status === 400) return new InvalidRequestError(args);
  return new LookupTaxError(args);
}
