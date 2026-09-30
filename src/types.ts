/**
 * The canonical outcome of a validation.
 *
 * Read `status` first — it is the single source of truth and the five values
 * are mutually exclusive. Deliberately do NOT branch on
 * `validation.overall.isValid`: that is `true` for VALID, UNVERIFIED and
 * INDETERMINATE alike, so a format-only pass looks identical to a
 * registry-confirmed one.
 */
export type ValidationStatus =
  /** Format passed and a government registry confirmed the entity. */
  | "VALID"
  /** Definitive negative: bad structure/check digit, or no registry record. */
  | "INVALID"
  /** No queryable registry for this country — only the format was checked. */
  | "UNVERIFIED"
  /** A registry was temporarily unreachable. Retry; do not treat as invalid. */
  | "INDETERMINATE"
  /** We do not validate this country or number type yet. */
  | "UNSUPPORTED";

export type ValidationReason =
  | "INVALID_FORMAT"
  | "INVALID_CHECKSUM"
  | "NOT_REGISTERED"
  | "NO_SOURCE_AVAILABLE"
  | "SOURCE_UNAVAILABLE"
  | "COUNTRY_NOT_SUPPORTED";

export interface ValidationResult {
  status: ValidationStatus;
  /** null only for VALID. */
  reason: ValidationReason | null;
  message: string;
  /** true only for INDETERMINATE. */
  retryable: boolean;
}

export interface StageStatus {
  isValid: boolean | null;
  attempted: boolean;
  errorCode?: string;
}

export interface ValidationStages {
  format: StageStatus;
  source: StageStatus;
  overall: StageStatus & { validationMethod: "FORMAT_STRUCTURE" | "SOURCE_DATABASE" };
}

export interface Entity {
  name?: string;
  address?: string;
  type?: string;
  status?: string;
}

export interface TinInfo {
  label: string;
  name: string;
  formattedTin?: string;
}

export interface ValidationResponse {
  referenceId: string;
  countryCode: string;
  requestDate: string;
  tin: string;
  result: ValidationResult;
  validation: ValidationStages;
  ui: { message: string; severity: "SUCCESS" | "WARNING" | "ERROR" | "INFO" };
  tinInfo: TinInfo;
  entity?: Entity;
  metadata?: Record<string, unknown>;
}

/**
 * EU-only routing preference. Ignored outside VIES-covered countries.
 *
 * With `vies` or `local` there is no fallback to the other family — if the
 * requested source cannot answer, the result is INDETERMINATE rather than
 * being silently answered by the other one.
 */
export type ValidationSource = "auto" | "vies" | "local";

export interface ValidateOptions {
  /** Idempotency key echoed back as `referenceId`. */
  referenceId?: string;
  validationSource?: ValidationSource;
  /** Extra registry params, e.g. `{ name: "ACME" }` for MX. */
  additionalParams?: Record<string, string>;
  signal?: AbortSignal;
}

export type BatchStatus = "pending" | "processing" | "completed" | "failed" | "canceled";
export type BatchItemStatus = BatchStatus;

export interface BatchTaxIdInput {
  countryIso: string;
  tin: string;
  /** Required where the registry matches on name (e.g. MX). */
  name?: string;
}

export interface BatchItem {
  request_id: string;
  country_iso: string;
  tin: string;
  status: BatchItemStatus;
  validation_result?: ValidationResponse;
  error_code?: string;
  error_message?: string;
  /** Present while the item is waiting to be retried. */
  next_retry_at?: string;
}

export interface BatchResults {
  status: BatchStatus;
  total_count: number;
  completed_count: number;
  success_count: number;
  error_count: number;
  canceled_count: number;
  results: BatchItem[];
  next_cursor: number | null;
}

export interface CreateBatchResponse {
  batch_id: string;
  status: BatchStatus;
  total_count: number;
}

export interface BatchSummary {
  id: string;
  status: BatchStatus;
  total_count: number;
  completed_count: number;
  success_count: number;
  error_count: number;
  user_id?: string;
  created_at: string;
  updated_at: string;
}

export interface BatchList {
  batches: BatchSummary[];
  total: number;
  page: number;
  limit: number;
}

export interface CreateBatchOptions {
  userId?: string;
  metadata?: Record<string, unknown>;
  /** Applies to every tax ID in the batch; non-EU rows are unaffected. */
  validationSource?: ValidationSource;
  signal?: AbortSignal;
}
