import { describe, it, expect, vi } from "vitest";
import { LookupTax, QuotaExceededError, RateLimitError, AuthenticationError, LookupTaxError } from "../src";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const client = (fetchImpl: any, opts = {}) =>
  new LookupTax({ apiKey: "k", fetch: fetchImpl, maxRetries: 0, ...opts });

const VALID = {
  referenceId: "r1",
  countryCode: "IE",
  tin: "53057102A",
  result: { status: "VALID", reason: null, message: "ok", retryable: false },
};

describe("request shape", () => {
  it("sends the API key and hits the configured base URL", async () => {
    const f = vi.fn().mockResolvedValue(json(VALID));
    await client(f).validate("IE", "53057102A");
    const [url, init] = f.mock.calls[0];
    expect(url).toContain("https://api.lookuptax.com/v1/validate");
    expect(init.headers["X-API-Key"]).toBe("k");
  });

  it("honours a custom baseUrl and strips a trailing slash", async () => {
    const f = vi.fn().mockResolvedValue(json(VALID));
    await client(f, { baseUrl: "https://api.lookuptax.com/" }).validate("IE", "1");
    expect(f.mock.calls[0][0]).toContain("https://api.lookuptax.com/validate");
  });

  it("nests additionalParams as additional_params[name]", async () => {
    const f = vi.fn().mockResolvedValue(json(VALID));
    await client(f).validate("MX", "XAXX010101000", { additionalParams: { name: "ACME" } });
    expect(decodeURIComponent(f.mock.calls[0][0])).toContain("additional_params[name]=ACME");
  });

  it("passes validation_source through", async () => {
    const f = vi.fn().mockResolvedValue(json(VALID));
    await client(f).validate("DE", "DE123", { validationSource: "vies" });
    expect(f.mock.calls[0][0]).toContain("validation_source=vies");
  });

  it("omits undefined query params entirely", async () => {
    const f = vi.fn().mockResolvedValue(json(VALID));
    await client(f).validate("IE", "1");
    expect(f.mock.calls[0][0]).not.toContain("reference_id");
  });
});

describe("outcomes vs errors", () => {
  // The distinction that matters most: an INVALID tax ID is a successful call.
  it("RESOLVES on INVALID rather than throwing", async () => {
    const body = { ...VALID, result: { status: "INVALID", reason: "NOT_REGISTERED", message: "", retryable: false } };
    const r = await client(vi.fn().mockResolvedValue(json(body))).validate("IE", "x");
    expect(r.result.status).toBe("INVALID");
  });

  it("RESOLVES on 422 UNSUPPORTED — the body still carries a result", async () => {
    const body = { ...VALID, result: { status: "UNSUPPORTED", reason: "COUNTRY_NOT_SUPPORTED", message: "", retryable: false } };
    const r = await client(vi.fn().mockResolvedValue(json(body, 422))).validate("ZZ", "x");
    expect(r.result.status).toBe("UNSUPPORTED");
  });

  it.each([
    [401, AuthenticationError],
    [402, QuotaExceededError],
    [429, RateLimitError],
  ])("throws a typed error on HTTP %s", async (status, Klass) => {
    const f = vi.fn().mockResolvedValue(json({ error: "e", message: "m" }, status as number));
    await expect(client(f).validate("IE", "1")).rejects.toBeInstanceOf(Klass as any);
  });

  it("exposes the machine-readable code, not just the message", async () => {
    const f = vi.fn().mockResolvedValue(json({ error: "quota_exceeded", message: "m" }, 402));
    await expect(client(f).validate("IE", "1")).rejects.toMatchObject({ code: "quota_exceeded", status: 402 });
  });

  it("surfaces Retry-After on 429", async () => {
    const f = vi.fn().mockResolvedValue(json({ error: "API_RATE_LIMIT" }, 429, { "retry-after": "7" }));
    await expect(client(f).validate("IE", "1")).rejects.toMatchObject({ retryAfter: 7 });
  });

  it("marks only 429/500/503 retryable", async () => {
    const mk = (s: number) => new LookupTaxError({ code: "c", status: s, message: "m" });
    expect(mk(429).isRetryable).toBe(true);
    expect(mk(503).isRetryable).toBe(true);
    expect(mk(400).isRetryable).toBe(false);
    expect(mk(402).isRetryable).toBe(false);
  });
});

describe("retries", () => {
  it("retries a 503 then succeeds", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json({ error: "service_unavailable" }, 503))
      .mockResolvedValueOnce(json(VALID));
    const r = await new LookupTax({ apiKey: "k", fetch: f, maxRetries: 1 }).validate("IE", "1");
    expect(f).toHaveBeenCalledTimes(2);
    expect(r.result.status).toBe("VALID");
  });

  it("never retries batch submission — a duplicate would double-reserve quota", async () => {
    const f = vi.fn().mockResolvedValue(json({ error: "service_unavailable" }, 503));
    await expect(
      new LookupTax({ apiKey: "k", fetch: f, maxRetries: 3 }).createBatch([{ countryIso: "IE", tin: "1" }]),
    ).rejects.toBeInstanceOf(LookupTaxError);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("batch", () => {
  it("maps camelCase input to the wire's snake_case", async () => {
    const f = vi.fn().mockResolvedValue(json({ batch_id: "b", status: "pending", total_count: 1 }));
    await client(f).createBatch([{ countryIso: "MX", tin: "X", name: "ACME" }], { validationSource: "local" });
    const body = JSON.parse(f.mock.calls[0][1].body);
    expect(body.tax_ids[0]).toEqual({ country_iso: "MX", tin: "X", name: "ACME" });
    expect(body.validation_source).toBe("local");
  });

  it("iterates every page by following next_cursor", async () => {
    const page = (results: any[], next: number | null) => json({ results, next_cursor: next, status: "completed" });
    const f = vi.fn()
      .mockResolvedValueOnce(page([{ request_id: "1" }], 1))
      .mockResolvedValueOnce(page([{ request_id: "2" }], null));
    const seen: string[] = [];
    for await (const i of client(f).iterateBatchResults("b")) seen.push(i.request_id);
    expect(seen).toEqual(["1", "2"]);
  });

  it("returns void on a 204 delete", async () => {
    const f = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await expect(client(f).deleteBatch("b")).resolves.toBeUndefined();
  });
});

describe("construction", () => {
  it("requires an apiKey", () => {
    expect(() => new LookupTax({ apiKey: "" } as any)).toThrow(/apiKey is required/);
  });
});
