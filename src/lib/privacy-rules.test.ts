import assert from "node:assert/strict";
import test from "node:test";
import { feedRestrictedUsers, marketingAudience, processingAllowed, requirePrivacyAcceptance } from "./privacy-rules";
import { CONSENT_ITEMS, PRIVACY_NOTICE_VERSION, PROCESSING_ACTIVITIES, RESTRICTABLE_ACTIVITIES } from "./privacy";
import { buildSeed } from "./seed";
import { AppError } from "./errors";
import type { PrivacyRecord, StoreData } from "./types";
import { testPassword } from "../test/support";

process.env.ACME_SEED_PASSWORD = testPassword();

function withRecord(data: StoreData, record: Partial<PrivacyRecord> & { userId: string }) {
  data.privacy = data.privacy.filter((item) => item.userId !== record.userId);
  data.privacy.push({ noticeVersion: PRIVACY_NOTICE_VERSION, decision: "accepted", decidedAt: new Date().toISOString(), language: "en", consents: {}, restrictions: {}, ...record });
}

const at = new Date().toISOString();

test("the register defines every purpose once; consent items and restrictable activities come from it", () => {
  const ids = PROCESSING_ACTIVITIES.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(CONSENT_ITEMS, ["delivery_phone", "marketing_email"]);
  assert.deepEqual(RESTRICTABLE_ACTIVITIES, ["delivery_phone", "marketing_email", "order_tracking_feed"]);
  for (const item of PROCESSING_ACTIVITIES) {
    assert.ok(item.purpose && item.data.length && item.retention && item.recipients.length, `${item.id} documents purpose, data, retention and recipients`);
    assert.ok(!(item.required && item.consent), `${item.id} cannot be both required and consent-based`);
  }
});

test("without an accepted notice nothing optional runs and personal data is not collected", async () => {
  const data = await buildSeed();
  for (const id of CONSENT_ITEMS) assert.equal(processingAllowed(data, "usr_01", id), false, `${id} is off by default`);
  assert.throws(() => requirePrivacyAcceptance(data, "usr_01"), (error: unknown) => error instanceof AppError && error.code === "consent_required");
  withRecord(data, { userId: "usr_01", decision: "declined" });
  assert.throws(() => requirePrivacyAcceptance(data, "usr_01"), AppError);
});

test("consent-based activities need a current opt-in; restriction overrides consent", async () => {
  const data = await buildSeed();
  withRecord(data, { userId: "usr_01", consents: { marketing_email: { granted: true, at, noticeVersion: PRIVACY_NOTICE_VERSION } } });
  assert.doesNotThrow(() => requirePrivacyAcceptance(data, "usr_01"));
  assert.equal(processingAllowed(data, "usr_01", "marketing_email"), true);
  assert.equal(processingAllowed(data, "usr_01", "delivery_phone"), false, "items are independent");
  withRecord(data, { userId: "usr_01", consents: { marketing_email: { granted: true, at, noticeVersion: "2025-01-01" } } });
  assert.equal(processingAllowed(data, "usr_01", "marketing_email"), false, "consent for an older notice no longer counts");
  withRecord(data, { userId: "usr_01", consents: { marketing_email: { granted: true, at, noticeVersion: PRIVACY_NOTICE_VERSION } }, restrictions: { marketing_email: { restricted: true, at } } });
  assert.equal(processingAllowed(data, "usr_01", "marketing_email"), false, "a restricted activity stops even with consent");
  assert.equal(processingAllowed(data, "usr_01", "order_fulfilment"), true, "contract processing continues");
});

test("marketing audience and realtime feed apply the same per-user checks", async () => {
  const data = await buildSeed();
  const consent = { marketing_email: { granted: true, at, noticeVersion: PRIVACY_NOTICE_VERSION } };
  withRecord(data, { userId: "usr_01", consents: consent });
  withRecord(data, { userId: "usr_06", consents: consent, restrictions: { marketing_email: { restricted: true, at }, order_tracking_feed: { restricted: true, at } } });
  withRecord(data, { userId: "usr_04", consents: consent });
  assert.deepEqual(marketingAudience(data).map((item) => item.id), ["usr_01"], "staff are never marketed to and restricted users are skipped");
  assert.deepEqual(feedRestrictedUsers(data), ["usr_06"]);
});
