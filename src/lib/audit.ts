import { createHmac, randomUUID } from "node:crypto";
import { sanitizeText, sha256 } from "./security";
import type { AppEvent, StoreData } from "./types";

/**
 * Audit trail protection (SD Elements T349). Every business and security event is appended through
 * appendEvent(), which chains it to the previous one: hash = HMAC-SHA256(ACME_AUDIT_KEY, previous
 * hash + event fields), or SHA-256 when no audit key is configured. Changing, removing or reordering
 * an event breaks the chain, and verifyAuditChain() reports where. No API changes or deletes
 * events; administrators read them through a read-only endpoint, and the oldest entries leave the
 * trail only by the retention limit.
 */
export const AUDIT_RETENTION = 400;

function auditKey(env: Record<string, string | undefined> = process.env): Buffer | null {
  const raw = env.ACME_AUDIT_KEY;
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  return key.length === 32 ? key : null;
}

function digest(event: AppEvent): string {
  const payload = JSON.stringify([event.prevHash ?? null, event.id, event.at, event.type, event.message, event.orderId, event.actorId]);
  const key = auditKey();
  return key ? createHmac("sha256", key).update(payload).digest("hex") : sha256(payload);
}

/** Appends an event to the chained, retention-limited audit trail (newest first). */
export function appendEvent(data: StoreData, input: { type: string; message: string; orderId: string | null; actorId: string | null }): AppEvent {
  const previous = data.events.find((item) => item.hash)?.hash ?? "genesis";
  const event: AppEvent = {
    id: randomUUID(),
    at: new Date().toISOString(),
    type: sanitizeText(input.type, 60),
    message: sanitizeText(input.message, 300),
    orderId: input.orderId,
    actorId: input.actorId,
    prevHash: previous,
  };
  event.hash = digest(event);
  data.events.unshift(event);
  data.events = data.events.slice(0, AUDIT_RETENTION);
  return event;
}

export interface AuditIntegrity {
  ok: boolean;
  checked: number;
  brokenAt: string | null;
}

/** Walks the chain from the oldest retained event to the newest. Events written before chaining are skipped. */
export function verifyAuditChain(events: readonly AppEvent[]): AuditIntegrity {
  const chain = [...events].reverse().filter((item) => item.hash);
  for (let index = 0; index < chain.length; index += 1) {
    const event = chain[index];
    if (digest(event) !== event.hash || (index > 0 && event.prevHash !== chain[index - 1].hash)) {
      return { ok: false, checked: index, brokenAt: event.id };
    }
  }
  return { ok: true, checked: chain.length, brokenAt: null };
}
