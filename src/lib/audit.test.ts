import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { appendEvent, AUDIT_RETENTION, verifyAuditChain } from "./audit";
import { buildSeed } from "./seed";
import { readStore, resetStore, updateStore } from "./db/store";
import { captureLogs, testPassword } from "../test/support";
import { AppError } from "./errors";
import { updateSettings } from "../services/retail";
import type { PublicUser, StoreData } from "./types";

process.env.ACME_DATA_PATH = "memory";
process.env.ACME_SEED_PASSWORD = testPassword();
const logs = captureLogs();

async function trail(count: number): Promise<StoreData> {
  const data = await buildSeed();
  for (let i = 0; i < count; i += 1) appendEvent(data, { type: "test.event", message: `event ${i}`, orderId: null, actorId: "usr_05" });
  return data;
}

test("audit trail: every event is chained to the previous one and the chain verifies", async () => {
  const data = await trail(5);
  assert.deepEqual(verifyAuditChain(data.events), { ok: true, checked: 5, brokenAt: null });
  assert.ok(data.events.slice(0, 5).every((event, index, list) => index === list.length - 1 || event.prevHash === list[index + 1].hash));
});

test("audit trail: changing, removing or reordering an event breaks the chain", async () => {
  const changed = await trail(5);
  changed.events[2].message = "nothing happened";
  assert.equal(verifyAuditChain(changed.events).ok, false);
  assert.equal(verifyAuditChain(changed.events).brokenAt, changed.events[2].id);
  const removed = await trail(5);
  removed.events.splice(2, 1);
  assert.equal(verifyAuditChain(removed.events).ok, false);
  const reordered = await trail(5);
  [reordered.events[1], reordered.events[2]] = [reordered.events[2], reordered.events[1]];
  assert.equal(verifyAuditChain(reordered.events).ok, false);
});

test("audit trail: with ACME_AUDIT_KEY the chain is an HMAC that cannot be recomputed without the key", async () => {
  process.env.ACME_AUDIT_KEY = randomBytes(32).toString("base64");
  try {
    const data = await trail(3);
    assert.equal(verifyAuditChain(data.events).ok, true);
    process.env.ACME_AUDIT_KEY = randomBytes(32).toString("base64");
    assert.equal(verifyAuditChain(data.events).ok, false, "a different key does not verify the trail");
  } finally {
    delete process.env.ACME_AUDIT_KEY;
  }
});

test("audit trail: retention keeps the newest events and the retained chain still verifies", async () => {
  const data = await trail(AUDIT_RETENTION + 20);
  assert.equal(data.events.length, AUDIT_RETENTION);
  assert.equal(verifyAuditChain(data.events).ok, true, "the oldest retained event anchors the chain");
});

const administrator: PublicUser = { id: "usr_05", email: "admin@acme-retail.test", fullName: "Jordan Hale", role: "administrator", phone: "", mustChangePassword: false, mfaEnabled: true };

test("database activity log: commits list record IDs, field names and non-personal values; personal values never appear", async () => {
  await resetStore();
  await updateStore((data) => {
    const order = data.orders.find((item) => item.id === "ord_001")!;
    order.deliveryStatus = "shipped";
    data.users.find((item) => item.id === "usr_01")!.fullName = "Avery Secret-Name";
  });
  const commit = logs.filter((entry) => entry.channel === "db" && entry.type === "db.commit").at(-1)!;
  assert.match(commit.txId ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(typeof commit.durationMs, "number");
  assert.ok(commit.detail?.includes("orders ~ord_001(deliveryStatus: processing->shipped)"), commit.detail);
  assert.ok(commit.detail?.includes("users ~usr_01(fullName)"), "a personal field is logged by name only");
  assert.ok(!JSON.stringify(logs).includes("Secret-Name"), "personal values never reach the log");
});

test("database activity log: a failed transaction is logged as a rollback and nothing is saved", async () => {
  const before = await readStore((data) => data.orderSeq);
  await assert.rejects(
    updateStore((data) => {
      data.orderSeq += 1;
      throw new AppError("Simulated failure.", 409, "conflict");
    }),
    AppError,
  );
  assert.equal(await readStore((data) => data.orderSeq), before);
  const rollback = logs.filter((entry) => entry.type === "db.rollback").at(-1)!;
  assert.equal(rollback.channel, "db");
  assert.equal(rollback.detail, "409 conflict");
});

test("configuration changes are logged with old and new values", async () => {
  await resetStore();
  await updateSettings(administrator, { paymentScenario: "declined" });
  const change = logs.filter((entry) => entry.type === "config.changed").at(-1)!;
  assert.equal(change.detail, "paymentScenario: approved->declined");
  assert.equal(change.actorId, "usr_05");
  const commit = logs.filter((entry) => entry.type === "db.commit").at(-1)!;
  assert.ok(commit.detail?.includes("settings ~settings(paymentScenario: approved->declined)"), commit.detail);
});
