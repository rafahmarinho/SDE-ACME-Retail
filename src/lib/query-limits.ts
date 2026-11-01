import { z } from "zod";
import { AppError } from "./errors";
import { securityLog } from "./security-log";

/**
 * Result-set size control (SD Elements T2600).
 *
 * - Sensitive list queries are paginated on the server: every request asks for at most `max` rows
 *   (a larger `limit` is rejected as invalid input) and the response carries `nextCursor`.
 * - Queries that are not paginated have a hard cap. A query that would produce more rows than its
 *   cap fails with an error instead of returning or processing an unbounded result; inside a store
 *   transaction (updateStore) the error also rolls the transaction back, because nothing is saved.
 * - The persisted snapshot itself has a size limit (MAX_SNAPSHOT_BYTES, see src/lib/db/store.ts).
 */
export const PAGE_LIMITS = {
  orders: { default: 20, max: 50 },
  officeOrders: { default: 50, max: 100 },
  refunds: { default: 50, max: 100 },
  returns: { default: 20, max: 50 },
  inventory: { default: 100, max: 200 },
  catalog: { default: 48, max: 96 },
  events: { default: 80, max: 100 },
} as const;

export type PageKind = keyof typeof PAGE_LIMITS;

/** Hard caps for results that are not paginated. */
export const RESULT_CAPS = {
  /** Distinct items in one cart. */
  cartItems: 50,
  /** Saved variants in one wishlist. */
  wishlistItems: 100,
  /** Orders a single simulation step may change. */
  simulationBatch: 500,
  /** Events, refunds and returns returned with one order. */
  orderEvents: 50,
  orderRefunds: 50,
  orderReturns: 50,
  /** Order rows mirrored to the realtime feed per save. */
  orderFeed: 200,
  /** Recipients of one product update e-mail run. */
  marketingBatch: 500,
} as const;

/** Largest serialized snapshot the store loads or saves (25 MB). */
export const MAX_SNAPSHOT_BYTES = 25 * 1024 * 1024;

export interface PageRequest {
  limit: number;
  offset: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
}

/** Query-string schema for one paginated endpoint: `limit` within the endpoint's maximum, opaque numeric `cursor`. */
export function pageQuery(kind: PageKind) {
  const limits = PAGE_LIMITS[kind];
  return z.object({
    limit: z.coerce.number().int().min(1).max(limits.max).default(limits.default),
    cursor: z.string().regex(/^\d{1,6}$/).optional(),
  });
}

export function parsePage(kind: PageKind, params: URLSearchParams): PageRequest {
  const parsed = pageQuery(kind).parse({ limit: params.get("limit") ?? undefined, cursor: params.get("cursor") ?? undefined });
  return { limit: parsed.limit, offset: parsed.cursor ? Number(parsed.cursor) : 0 };
}

/** Default first page of a kind (services called without an explicit page). */
export function firstPage(kind: PageKind): PageRequest {
  return { limit: PAGE_LIMITS[kind].default, offset: 0 };
}

/** Returns one page of an already filtered and ordered result. The page size never exceeds the kind's maximum. */
export function paginate<T>(rows: readonly T[], page: PageRequest, kind: PageKind): Page<T> {
  const limit = Math.min(Math.max(1, Math.trunc(page.limit)), PAGE_LIMITS[kind].max);
  const offset = Math.max(0, Math.trunc(page.offset));
  const end = offset + limit;
  return { items: rows.slice(offset, end), nextCursor: end < rows.length ? String(end) : null, total: rows.length };
}

export class ResultTooLargeError extends AppError {
  constructor() {
    super("This request would return or change too many records. Narrow it down and try again.", 422, "result_too_large");
  }
}

/**
 * Hard cap for queries that are not paginated: more rows than the cap is an error (logged), never a
 * silent truncation. Thrown inside updateStore it aborts the transaction before anything is saved.
 */
export function withinCap<T>(rows: readonly T[], cap: number, query: string): readonly T[] {
  if (rows.length > cap) {
    securityLog({ type: "query.result_too_large", outcome: "blocked", detail: `${query}: ${rows.length} rows exceed the cap of ${cap}` });
    throw new ResultTooLargeError();
  }
  return rows;
}
