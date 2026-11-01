import { AppError } from "./errors";
import { can } from "./policy";
import { activity, PRIVACY_NOTICE_VERSION, type ActivityId, type ConsentItemId } from "./privacy";
import type { PrivacyRecord, StoreData } from "./types";

/**
 * Server-side privacy checks (SD Elements T178, T604, T754). Pure functions over the store data, so
 * the services and the database layer use the same rules before processing personal information.
 */
export function emptyPrivacyRecord(userId: string): PrivacyRecord {
  return { userId, noticeVersion: null, decision: null, decidedAt: null, language: "en", consents: {}, restrictions: {} };
}

export function privacyRecordOf(data: StoreData, userId: string): PrivacyRecord {
  return data.privacy.find((item) => item.userId === userId) ?? emptyPrivacyRecord(userId);
}

export function hasCurrentAcceptance(record: PrivacyRecord): boolean {
  return record.decision === "accepted" && record.noticeVersion === PRIVACY_NOTICE_VERSION;
}

export function consentGranted(record: PrivacyRecord, id: ConsentItemId): boolean {
  const entry = record.consents[id];
  return hasCurrentAcceptance(record) && Boolean(entry?.granted) && entry.noticeVersion === PRIVACY_NOTICE_VERSION;
}

/**
 * The check made before any processing activity on a user's personal information. Consent-based
 * activities need a current opt-in; an activity the user restricted is not allowed for that user.
 */
export function processingAllowed(data: StoreData, userId: string, id: ActivityId): boolean {
  const definition = activity(id);
  const record = privacyRecordOf(data, userId);
  if (definition.restrictable && record.restrictions[id]?.restricted) return false;
  if (definition.consent) return consentGranted(record, id as ConsentItemId);
  return true;
}

/** Personal data is collected only after the current privacy notice has been accepted. */
export function requirePrivacyAcceptance(data: StoreData, userId: string) {
  if (!hasCurrentAcceptance(privacyRecordOf(data, userId))) {
    throw new AppError("Review and accept the privacy notice before we collect your details.", 409, "consent_required");
  }
}

/** Customers who opted in to product update e-mails and did not restrict them, evaluated at send time. */
export function marketingAudience(data: StoreData) {
  return data.users
    .filter((user) => can(user.role, "orders.purchase") && processingAllowed(data, user.id, "marketing_email"))
    .map((user) => ({ id: user.id, email: user.email, fullName: user.fullName }));
}

/** Accounts whose orders must not be mirrored to the realtime feed (order_tracking_feed restricted). */
export function feedRestrictedUsers(data: StoreData): string[] {
  return data.users.filter((user) => !processingAllowed(data, user.id, "order_tracking_feed")).map((user) => user.id);
}
