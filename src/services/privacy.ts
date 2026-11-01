import { randomUUID } from "node:crypto";
import { AppError } from "../lib/errors";
import { readStore, updateStore } from "../lib/db/store";
import { securityLog } from "../lib/security-log";
import { appendEvent } from "../lib/audit";
import { CONSENT_ITEMS, PRIVACY_NOTICE_VERSION, PROCESSING_ACTIVITIES, RESTRICTABLE_ACTIVITIES, type ConsentItemId, type RestrictableId } from "../lib/privacy";
import { consentGranted, emptyPrivacyRecord, hasCurrentAcceptance, privacyRecordOf, processingAllowed } from "../lib/privacy-rules";
import type { ConsentEvent, PrivacyRecord, StoreData } from "../lib/types";

/**
 * Consent capture, consent withdrawal and restriction of processing (SD Elements T178, T604,
 * T754), stored server-side. Every decision is kept in the append-only consentLog with the items,
 * the notice version, the language preference, the date and time and the signed-in session that
 * made it. The checks used before processing live in src/lib/privacy-rules.ts.
 */
export interface ConsentEvidence {
  /** First 16 hex characters of the session token hash: links the decision to the signed-in session. */
  sessionRef: string;
  ip: string;
  userAgent: string;
}

function nowIso() {
  return new Date().toISOString();
}

function recordFor(data: StoreData, userId: string): PrivacyRecord {
  let record = data.privacy.find((item) => item.userId === userId);
  if (!record) {
    record = emptyPrivacyRecord(userId);
    data.privacy.push(record);
  }
  return record;
}

function logDecision(data: StoreData, userId: string, action: ConsentEvent["action"], items: string[], language: string, evidence: ConsentEvidence) {
  const at = nowIso();
  data.consentLog.push({ id: randomUUID(), userId, at, action, items, noticeVersion: PRIVACY_NOTICE_VERSION, language, evidence });
  appendEvent(data, { type: `privacy.${action}`, message: `Privacy decision (${action.replace("_", " ")}): ${items.join(", ") || "no optional items"}.`, orderId: null, actorId: userId });
  securityLog({ type: `privacy.${action}`, outcome: "success", actorId: userId, ip: evidence.ip, detail: items.join(",") || "none" });
}

/** The account's privacy state: notice decision, consent items, restriction checklist and recent decisions. */
export function privacyView(data: StoreData, userId: string) {
  const current = privacyRecordOf(data, userId);
  const forCurrentNotice = current.noticeVersion === PRIVACY_NOTICE_VERSION;
  return {
    noticeVersion: PRIVACY_NOTICE_VERSION,
    accepted: hasCurrentAcceptance(current),
    decision: forCurrentNotice ? current.decision : null,
    decidedAt: forCurrentNotice ? current.decidedAt : null,
    language: current.language,
    consents: CONSENT_ITEMS.map((id) => ({ id, granted: consentGranted(current, id), at: current.consents[id]?.at ?? null })),
    restrictions: RESTRICTABLE_ACTIVITIES.map((id) => ({ id, restricted: Boolean(current.restrictions[id]?.restricted), at: current.restrictions[id]?.at ?? null })),
    activities: PROCESSING_ACTIVITIES.map((item) => ({ id: item.id, allowed: processingAllowed(data, userId, item.id) })),
    history: data.consentLog
      .filter((entry) => entry.userId === userId)
      .slice(-20)
      .reverse()
      .map((entry) => ({ id: entry.id, at: entry.at, action: entry.action, items: entry.items, noticeVersion: entry.noticeVersion })),
  };
}

export type PrivacyView = ReturnType<typeof privacyView>;

export async function getPrivacy(userId: string): Promise<PrivacyView> {
  return readStore((data) => privacyView(data, userId));
}

/**
 * Consent form decision (Accept or Decline) for the current notice. Optional items are granted
 * only when explicitly set to true; Decline grants nothing.
 */
export async function decidePrivacy(
  userId: string,
  input: { decision: "accept" | "decline"; noticeVersion: string; language: string; consents: Partial<Record<ConsentItemId, boolean>> },
  evidence: ConsentEvidence,
): Promise<PrivacyView> {
  return updateStore((data) => {
    if (input.noticeVersion !== PRIVACY_NOTICE_VERSION) {
      throw new AppError("The privacy notice has changed. Review the current version and decide again.", 409, "notice_outdated");
    }
    const target = recordFor(data, userId);
    const at = nowIso();
    target.noticeVersion = PRIVACY_NOTICE_VERSION;
    target.decision = input.decision === "accept" ? "accepted" : "declined";
    target.decidedAt = at;
    target.language = input.language;
    const granted: string[] = [];
    for (const id of CONSENT_ITEMS) {
      const value = input.decision === "accept" && input.consents[id] === true;
      target.consents[id] = { granted: value, at, noticeVersion: PRIVACY_NOTICE_VERSION };
      if (value) granted.push(id);
    }
    logDecision(data, userId, input.decision, granted, target.language, evidence);
    return privacyView(data, userId);
  });
}

/** Consent toggles: withdrawal is always possible; granting needs the current notice to be accepted. */
export async function updateConsents(userId: string, changes: Partial<Record<ConsentItemId, boolean>>, evidence: ConsentEvidence): Promise<PrivacyView> {
  return updateStore((data) => {
    const target = recordFor(data, userId);
    const at = nowIso();
    const granted: string[] = [];
    const withdrawn: string[] = [];
    for (const id of CONSENT_ITEMS) {
      const next = changes[id];
      if (next === undefined) continue;
      if (next && !hasCurrentAcceptance(target)) {
        throw new AppError("Accept the current privacy notice before giving consent.", 409, "consent_required");
      }
      const before = consentGranted(target, id);
      target.consents[id] = { granted: next, at, noticeVersion: PRIVACY_NOTICE_VERSION };
      if (next && !before) granted.push(id);
      if (!next && before) withdrawn.push(id);
    }
    if (granted.length) logDecision(data, userId, "grant", granted, target.language, evidence);
    if (withdrawn.length) logDecision(data, userId, "withdraw", withdrawn, target.language, evidence);
    return privacyView(data, userId);
  });
}

/** Restriction checklist: the user objects to (or allows again) a restrictable activity. */
export async function updateRestrictions(userId: string, changes: Partial<Record<RestrictableId, boolean>>, evidence: ConsentEvidence): Promise<PrivacyView> {
  return updateStore((data) => {
    const target = recordFor(data, userId);
    const at = nowIso();
    const restricted: string[] = [];
    const lifted: string[] = [];
    for (const id of RESTRICTABLE_ACTIVITIES) {
      const next = changes[id];
      if (next === undefined) continue;
      const before = Boolean(target.restrictions[id]?.restricted);
      target.restrictions[id] = { restricted: next, at };
      if (next && !before) restricted.push(id);
      if (!next && before) lifted.push(id);
    }
    if (restricted.length) logDecision(data, userId, "restrict", restricted, target.language, evidence);
    if (lifted.length) logDecision(data, userId, "lift_restriction", lifted, target.language, evidence);
    return privacyView(data, userId);
  });
}
