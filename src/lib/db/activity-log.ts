import type { StoreData } from "../types";

/**
 * Data-change metadata for the database activity log (SD Elements T2602). Each committed store
 * transaction is summarized per collection: the IDs of records added, removed or changed, the names
 * of the changed fields and, for fields that carry no personal data, the old and new values.
 * Personal data (names, addresses, phones, e-mail, hashes, tokens) is never written to the log;
 * only the field name appears (T349: no unneeded sensitive data in logs).
 */
const COLLECTIONS = [
  "users", "addresses", "products", "variants", "coupons", "carts", "wishlists", "orders", "reservations", "checkouts",
  "returns", "refunds", "uploads", "resetTokens", "sessions", "privacy", "consentLog",
] as const;

/** Fields whose values are logged; every other field is logged by name only. */
const VALUE_FIELDS = new Set([
  "paymentStatus", "deliveryStatus", "status", "stock", "reserved", "active", "featured", "priceCents", "role", "decision",
  "noticeVersion", "amountCents", "partial", "carrier", "qty", "mustChangePassword", "paymentScenario", "authChallengeResult",
  "taxRateBps", "reservationMinutes",
]);

type Fingerprint = Map<string, Map<string, string>>;

function recordId(item: Record<string, unknown>, index: number): string {
  const value = item.id ?? item.userId ?? item.code ?? item.key;
  return typeof value === "string" ? value : `#${index}`;
}

/** Serialized records per collection, taken before a transaction runs. */
export function fingerprint(data: StoreData): Fingerprint {
  const result: Fingerprint = new Map();
  for (const name of COLLECTIONS) {
    const rows = new Map<string, string>();
    ((data[name] ?? []) as unknown as Record<string, unknown>[]).forEach((item, index) => rows.set(recordId(item, index), JSON.stringify(item)));
    result.set(name, rows);
  }
  result.set("settings", new Map([["settings", JSON.stringify(data.settings)]]));
  return result;
}

function show(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 40) : JSON.stringify(value)?.slice(0, 40) ?? "null";
}

function fieldChanges(before: string, after: string): string {
  const old = JSON.parse(before) as Record<string, unknown>;
  const next = JSON.parse(after) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(old), ...Object.keys(next)])].filter((key) => JSON.stringify(old[key]) !== JSON.stringify(next[key]));
  return keys.map((key) => (VALUE_FIELDS.has(key) ? `${key}: ${show(old[key])}->${show(next[key])}` : key)).join(", ");
}

/** Change summary of a committed transaction, e.g. "orders ~ord_001(deliveryStatus: processing->shipped, updatedAt)". */
export function describeChanges(before: Fingerprint, data: StoreData): string[] {
  const after = fingerprint(data);
  const lines: string[] = [];
  for (const [name, rows] of after) {
    const previous = before.get(name) ?? new Map<string, string>();
    const parts: string[] = [];
    for (const [id, json] of rows) {
      const old = previous.get(id);
      if (old === undefined) parts.push(`+${id}`);
      else if (old !== json) parts.push(`~${id}(${fieldChanges(old, json)})`);
    }
    for (const id of previous.keys()) if (!rows.has(id)) parts.push(`-${id}`);
    if (parts.length) lines.push(`${name} ${parts.slice(0, 10).join(" ")}${parts.length > 10 ? ` (+${parts.length - 10} more)` : ""}`);
  }
  return lines;
}
