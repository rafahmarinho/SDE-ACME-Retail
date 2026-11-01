import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { KEY_REGISTRY, keyHealth, parseDataKeys } from "./keys";
import { assertEncryptionAvailable, isSealedBytes, openBytes, openText, sealBytes, sealText, SNAPSHOT_AAD, UPLOAD_AAD } from "./data-crypto";
import { AppError } from "./errors";
import { captureLogs } from "../test/support";

const logs = captureLogs();
const key = () => randomBytes(32).toString("base64");

test("every key is registered with one purpose, generation, storage, rotation and revocation", () => {
  const names = KEY_REGISTRY.map((item) => item.env);
  assert.equal(new Set(names).size, names.length);
  for (const name of ["ACME_DATA_KEYS", "SUPABASE_SERVICE_ROLE_KEY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "MAIL_WEBHOOK_TOKEN"]) assert.ok(names.includes(name), name);
  for (const item of KEY_REGISTRY) {
    for (const field of [item.purpose, item.generation, item.storage, item.rotation, item.revocation]) assert.ok(field.length > 10, item.env);
    assert.ok(item.rotationDays > 0 && item.rotationDays <= 365, item.env);
  }
});

test("data keys must be 256-bit, uniquely named; the first one is active", () => {
  const [k1, k2] = [key(), key()];
  assert.deepEqual(parseDataKeys(`k2:${k2},k1:${k1}`).map((item) => item.id), ["k2", "k1"]);
  assert.equal(parseDataKeys(k1)[0].id, "k1", "a single key gets the id k1");
  assert.deepEqual(parseDataKeys(`k1:${randomBytes(16).toString("base64")}`), [], "128-bit keys are refused");
  assert.deepEqual(parseDataKeys(`k1:${k1},k1:${k2}`), [], "duplicate ids are refused");
});

test("key health reports missing production keys, reuse across purposes and overdue rotation, never values", () => {
  const shared = `whsec_${randomBytes(16).toString("hex")}`;
  const findings = keyHealth({ NODE_ENV: "production", STRIPE_WEBHOOK_SECRET: shared, STRIPE_WEBHOOK_SECRET_PREVIOUS: shared, MAIL_WEBHOOK_TOKEN: randomBytes(24).toString("hex"), MAIL_WEBHOOK_TOKEN_CREATED_AT: "2025-01-01T00:00:00Z" }, Date.parse("2026-10-19T00:00:00Z"));
  assert.ok(findings.includes("ACME_DATA_KEYS: missing (required in production)"));
  assert.ok(findings.some((item) => item.startsWith("STRIPE_WEBHOOK_SECRET_PREVIOUS: same value as STRIPE_WEBHOOK_SECRET")));
  assert.ok(findings.includes("MAIL_WEBHOOK_TOKEN: rotation due (older than 90 days)"));
  assert.ok(!findings.join(" ").includes(shared), "findings never contain key material");
  assert.deepEqual(keyHealth({ NODE_ENV: "production", ACME_DATA_KEYS: `k1:${key()}` }), []);
});

test("AES-256-GCM sealing: random IV, authenticated, bound to its purpose", () => {
  const env = { ACME_DATA_KEYS: `k1:${key()}` };
  const first = sealText('{"users":[{"fullName":"Avery Chen"}]}', SNAPSHOT_AAD, env);
  const second = sealText('{"users":[{"fullName":"Avery Chen"}]}', SNAPSHOT_AAD, env);
  assert.notEqual(first.iv, second.iv, "a fresh IV for every write");
  assert.ok(!JSON.stringify(first).includes("Avery"));
  assert.equal(openText(first, SNAPSHOT_AAD, env), '{"users":[{"fullName":"Avery Chen"}]}');
  const flipped = Buffer.from(first.data, "base64");
  flipped[0] ^= 0xff;
  const tampered = { ...first, data: flipped.toString("base64") };
  assert.throws(() => openText(tampered, SNAPSHOT_AAD, env), (error: unknown) => error instanceof AppError && error.code === "integrity_error");
  assert.throws(() => openText(first, UPLOAD_AAD, env), AppError, "a snapshot cannot be opened as an upload");
  const photo = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const sealed = sealBytes(photo, UPLOAD_AAD, env);
  assert.ok(isSealedBytes(sealed) && !isSealedBytes(photo));
  assert.deepEqual(new Uint8Array(openBytes(sealed, UPLOAD_AAD, env)), photo);
  assert.ok(logs.some((entry) => entry.type === "data.decrypt_failed"));
});

test("rotation: old data opens while its key is listed; new writes use the first key", () => {
  const [k1, k2] = [key(), key()];
  const old = sealText("secret data", SNAPSHOT_AAD, { ACME_DATA_KEYS: `k1:${k1}` });
  const rotated = { ACME_DATA_KEYS: `k2:${k2},k1:${k1}` };
  assert.equal(openText(old, SNAPSHOT_AAD, rotated), "secret data");
  assert.equal(sealText("secret data", SNAPSHOT_AAD, rotated).kid, "k2");
  assert.throws(() => openText(old, SNAPSHOT_AAD, { ACME_DATA_KEYS: `k2:${k2}` }), AppError, "a retired key no longer opens data");
});

test("production refuses to write personal data without a data key", () => {
  assert.throws(() => assertEncryptionAvailable({ NODE_ENV: "production" }), (error: unknown) => error instanceof AppError && error.status === 503);
  assert.doesNotThrow(() => assertEncryptionAvailable({ NODE_ENV: "production", ACME_DATA_KEYS: `k1:${key()}` }));
  assert.ok(logs.some((entry) => entry.type === "data.key_missing"));
});
