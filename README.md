# LookupTax SDK for TypeScript & JavaScript

Validate tax IDs — VAT, EIN, GSTIN, ABN and more — against official government registries.

Written in TypeScript, published with compiled JS and type definitions, so JavaScript and TypeScript projects both consume it the same way.

```bash
npm install @lookuptax/sdk
```

Requires Node 18+ (or any runtime with global `fetch`).

## Quick start

```ts
import { LookupTax } from "@lookuptax/sdk";

const lookuptax = new LookupTax({ apiKey: process.env.LOOKUPTAX_API_KEY! });

const res = await lookuptax.validate("IE", "53057102A");

if (res.result.status === "VALID") {
  console.log("Confirmed:", res.entity?.name);
}
```

## Read `result.status`, not `isValid`

Every response carries a `result` object whose `status` is the single source of truth. There are five mutually exclusive values:

| `result.status` | Meaning |
|---|---|
| `VALID` | Format passed and a government registry confirmed the entity. |
| `INVALID` | Definitive negative — bad structure/check digit, or no registry record. |
| `UNVERIFIED` | No queryable registry for that country, so only the format was checked. A pass is **not** proof the business exists. |
| `INDETERMINATE` | A registry was temporarily unreachable. Retry — do not treat as invalid. |
| `UNSUPPORTED` | We don't validate that country or number type yet. |

Do **not** branch on `validation.overall.isValid`: it is `true` for `VALID`, `UNVERIFIED` **and** `INDETERMINATE` alike, so a format-only pass looks identical to a registry-confirmed one. `result.status` exists to remove that ambiguity.

```ts
switch (res.result.status) {
  case "VALID":         return accept(res.entity);
  case "INVALID":       return reject(res.result.reason);
  case "UNVERIFIED":    return acceptWithCaveat();   // format checked only
  case "INDETERMINATE": return retryLater();         // registry was down
  case "UNSUPPORTED":   return skip();
}
```

## Errors vs outcomes

The SDK mirrors the API's split, and the distinction matters:

- **Validation outcomes resolve.** An `INVALID` tax ID is a *successful* call — you get a response, not an exception. `UNSUPPORTED` resolves too, even though it arrives as HTTP 422, because the body still carries a `result`.
- **Request errors throw.** Authentication, quota, rate limit, malformed request — the call could not be processed at all.

```ts
import { LookupTaxError, QuotaExceededError, RateLimitError } from "@lookuptax/sdk";

try {
  const res = await lookuptax.validate("IE", "53057102A");
} catch (err) {
  if (err instanceof RateLimitError) await sleep((err.retryAfter ?? 1) * 1000);
  else if (err instanceof QuotaExceededError) notifyBilling();
  else if (err instanceof LookupTaxError) console.error(err.code, err.status);
}
```

Branch on `err.code` (a stable machine-readable string), never on `err.message`.

Transient failures — 429, 500, 503 — are retried automatically (2 attempts by default, honouring `Retry-After`). Set `maxRetries: 0` to opt out. Batch submission is **never** retried automatically, because a retried submission that actually succeeded would create a second batch and reserve quota twice.

## EU routing

For EU member states you can choose which authority answers:

```ts
await lookuptax.validate("DE", "DE123456789", { validationSource: "vies" });  // VIES only
await lookuptax.validate("DE", "DE123456789", { validationSource: "local" }); // national registry only
```

With `vies` or `local` there is no fallback to the other — if the requested source cannot answer you get `INDETERMINATE` rather than a silent answer from the other one, which is what makes it usable for reconciliation. Default is `auto`. Ignored outside VIES-covered countries.

## Countries needing a name

Some registries match on name as well as number:

```ts
await lookuptax.validate("MX", "XAXX010101000", {
  additionalParams: { name: "Empresa Ejemplo SA de CV" },
});
```

## Batch

Submit up to 100 IDs; validation runs asynchronously. Enterprise plan only.

```ts
const batch = await lookuptax.createBatch([
  { countryIso: "IE", tin: "53057102A" },
  { countryIso: "MX", tin: "XAXX010101000", name: "Empresa Ejemplo SA de CV" },
]);

const done = await lookuptax.waitForBatch(batch.batch_id);

for await (const item of lookuptax.iterateBatchResults(batch.batch_id)) {
  console.log(item.tin, item.validation_result?.result.status);
}
```

`waitForBatch` polls on a relaxed cadence by design. When a registry is unreachable an item keeps retrying for roughly three days, carrying a `next_retry_at` — a long-running item is not a stuck one.

## Configuration

```ts
new LookupTax({
  apiKey:    "…",                               // required
  baseUrl:   "https://api.lookuptax.com/v1",    // default
  timeoutMs: 30_000,                            // per request
  maxRetries: 2,                                // 429/500/503 only
  fetch:     customFetch,                       // inject an agent/proxy, or for tests
});
```

`baseUrl` is configurable because the published path prefix is deployment configuration rather than a property of the SDK — point it at whichever root serves your account.

## API

| Method | Endpoint |
|---|---|
| `validate(countryIso, tin, opts?)` | `GET /validate` |
| `createBatch(taxIds, opts?)` | `POST /batch` |
| `getBatch(batchId, opts?)` | `GET /batch/{id}` |
| `listBatches(opts?)` | `GET /batch` |
| `cancelBatch(batchId)` | `POST /batch/{id}/cancel` |
| `deleteBatch(batchId)` | `DELETE /batch/{id}` |
| `getTaxId(requestId)` | `GET /batch/tax-id/{id}` |
| `waitForBatch(batchId, opts?)` | polls `getBatch` to a terminal state |
| `iterateBatchResults(batchId, opts?)` | async iterator over every page |

## License

MIT
