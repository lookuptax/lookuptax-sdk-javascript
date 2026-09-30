import { errorFromResponse, LookupTaxError } from "./errors";
import type {
  BatchList,
  BatchResults,
  BatchTaxIdInput,
  CreateBatchOptions,
  CreateBatchResponse,
  BatchItem,
  ValidateOptions,
  ValidationResponse,
} from "./types";

/**
 * Default API root.
 *
 * Overridable via `baseUrl` because the published path prefix is deployment
 * configuration, not a property of the SDK — point it wherever your account
 * is served from.
 */
export const DEFAULT_BASE_URL = "https://api.lookuptax.com/v1";

export interface LookupTaxOptions {
  apiKey: string;
  baseUrl?: string;
  /** Per-request timeout in ms. Default 30s; batch submission can be slower. */
  timeoutMs?: number;
  /**
   * Retries for transient failures (429/500/503) using the `Retry-After`
   * header when present, else exponential backoff. Default 2. Set 0 to
   * disable. Only idempotent reads and explicitly safe calls are retried.
   */
  maxRetries?: number;
  /** Injectable for tests or a custom agent/proxy. */
  fetch?: typeof fetch;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class LookupTax {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: LookupTaxOptions) {
    if (!opts?.apiKey) throw new Error("LookupTax: apiKey is required");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    if (!this.fetchImpl) {
      throw new Error("LookupTax: no global fetch available — pass one via options.fetch");
    }
  }

  // ─── HTTP ──────────────────────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    opts: { query?: Record<string, unknown>; body?: unknown; signal?: AbortSignal; retry?: boolean } = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v === undefined || v === null) continue;
      if (typeof v === "object") {
        // Nested params render as `additional_params[name]=…`, the shape the
        // API expects; a flat `?name=` is stripped before it reaches routing.
        for (const [ik, iv] of Object.entries(v as Record<string, unknown>)) {
          if (iv !== undefined && iv !== null) url.searchParams.append(`${k}[${ik}]`, String(iv));
        }
      } else {
        url.searchParams.append(k, String(v));
      }
    }

    const attempts = opts.retry === false ? 1 : this.maxRetries + 1;
    let lastErr: unknown;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const timer = new AbortController();
      const timeout = setTimeout(() => timer.abort(), this.timeoutMs);
      // Caller-supplied cancellation must win over our timeout.
      const onAbort = () => timer.abort();
      opts.signal?.addEventListener("abort", onAbort);

      try {
        const res = await this.fetchImpl(url.toString(), {
          method,
          headers: {
            "X-API-Key": this.apiKey,
            Accept: "application/json",
            ...(opts.body ? { "Content-Type": "application/json" } : {}),
          },
          body: opts.body ? JSON.stringify(opts.body) : undefined,
          signal: timer.signal,
        });

        if (res.status === 204) return undefined as T;

        const text = await res.text();
        const parsed = text ? safeJson(text) : undefined;

        // 422 is an OUTCOME, not a failure: the body still carries `result`
        // with status UNSUPPORTED. Return it so callers read it uniformly.
        if (res.ok || (res.status === 422 && parsed?.result)) return parsed as T;

        const retryAfterHeader = res.headers.get("retry-after");
        const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : undefined;
        const err = errorFromResponse(res.status, parsed, Number.isFinite(retryAfter!) ? retryAfter : undefined);

        if (err.isRetryable && attempt < attempts - 1) {
          lastErr = err;
          await sleep(err.retryAfter ? err.retryAfter * 1000 : 2 ** attempt * 500);
          continue;
        }
        throw err;
      } catch (e) {
        if (e instanceof LookupTaxError) throw e;
        // Network failure or timeout — retry if budget remains.
        lastErr = e;
        if (attempt < attempts - 1) {
          await sleep(2 ** attempt * 500);
          continue;
        }
        throw e;
      } finally {
        clearTimeout(timeout);
        opts.signal?.removeEventListener("abort", onAbort);
      }
    }
    throw lastErr;
  }

  // ─── Single validation ─────────────────────────────────────────────

  /**
   * Validate one tax ID.
   *
   * Resolves for every validation outcome, including INVALID — read
   * `result.status`. It throws only when the request itself could not be
   * processed (auth, quota, rate limit, malformed request).
   */
  async validate(countryIso: string, tin: string, opts: ValidateOptions = {}): Promise<ValidationResponse> {
    return this.request<ValidationResponse>("GET", "/validate", {
      query: {
        country_iso: countryIso,
        tin,
        reference_id: opts.referenceId,
        validation_source: opts.validationSource,
        additional_params: opts.additionalParams,
      },
      signal: opts.signal,
    });
  }

  // ─── Batch ─────────────────────────────────────────────────────────

  /**
   * Submit up to 100 tax IDs. Runs asynchronously — poll `getBatch()`.
   * Enterprise plan only; other plans receive 403.
   *
   * Not retried automatically: a retried submission that actually succeeded
   * would create a second batch and reserve quota twice.
   */
  async createBatch(taxIds: BatchTaxIdInput[], opts: CreateBatchOptions = {}): Promise<CreateBatchResponse> {
    return this.request<CreateBatchResponse>("POST", "/batch", {
      body: {
        tax_ids: taxIds.map((t) => ({
          country_iso: t.countryIso,
          tin: t.tin,
          ...(t.name ? { name: t.name } : {}),
        })),
        user_id: opts.userId,
        metadata: opts.metadata,
        validation_source: opts.validationSource,
      },
      signal: opts.signal,
      retry: false,
    });
  }

  /** Fetch batch progress and one page of results. */
  async getBatch(
    batchId: string,
    opts: { limit?: number; cursor?: number; signal?: AbortSignal } = {},
  ): Promise<BatchResults> {
    return this.request<BatchResults>("GET", `/batch/${encodeURIComponent(batchId)}`, {
      query: { limit: opts.limit, cursor: opts.cursor },
      signal: opts.signal,
    });
  }

  /** List your organization's batches, newest first. Pages with page/limit. */
  async listBatches(opts: { page?: number; limit?: number; signal?: AbortSignal } = {}): Promise<BatchList> {
    return this.request<BatchList>("GET", "/batch", {
      query: { page: opts.page, limit: opts.limit },
      signal: opts.signal,
    });
  }

  /** Cancel a pending/processing batch. Reserved quota is released. */
  async cancelBatch(batchId: string, opts: { signal?: AbortSignal } = {}): Promise<CreateBatchResponse> {
    return this.request<CreateBatchResponse>("POST", `/batch/${encodeURIComponent(batchId)}/cancel`, {
      signal: opts.signal,
      retry: false,
    });
  }

  /** Permanently delete a terminal batch and its records. Cannot be undone. */
  async deleteBatch(batchId: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
    await this.request<void>("DELETE", `/batch/${encodeURIComponent(batchId)}`, {
      signal: opts.signal,
      retry: false,
    });
  }

  /** Fetch one item from a batch by its `request_id`, without paging. */
  async getTaxId(requestId: string, opts: { signal?: AbortSignal } = {}): Promise<BatchItem> {
    return this.request<BatchItem>("GET", `/batch/tax-id/${encodeURIComponent(requestId)}`, {
      signal: opts.signal,
    });
  }

  // ─── Convenience ───────────────────────────────────────────────────

  /**
   * Poll until the batch reaches a terminal state, then return the final page.
   *
   * Items can retry for roughly three days when a registry is unreachable, so
   * this defaults to a relaxed cadence and a generous ceiling rather than
   * treating a long-running item as stuck.
   */
  async waitForBatch(
    batchId: string,
    opts: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<BatchResults> {
    const interval = opts.intervalMs ?? 5_000;
    const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60_000);
    for (;;) {
      const batch = await this.getBatch(batchId, { signal: opts.signal });
      if (batch.status === "completed" || batch.status === "failed" || batch.status === "canceled") {
        return batch;
      }
      if (Date.now() >= deadline) {
        throw new Error(`LookupTax: batch ${batchId} still ${batch.status} after timeout`);
      }
      await sleep(interval);
    }
  }

  /** Every page of a batch's results, following `next_cursor`. */
  async *iterateBatchResults(
    batchId: string,
    opts: { limit?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<BatchItem> {
    let cursor: number | undefined;
    for (;;) {
      const page = await this.getBatch(batchId, { limit: opts.limit, cursor, signal: opts.signal });
      for (const item of page.results) yield item;
      if (page.next_cursor === null || page.next_cursor === undefined) return;
      cursor = page.next_cursor;
    }
  }
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}
