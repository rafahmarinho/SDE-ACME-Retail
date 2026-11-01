import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { randomBytes, scryptSync } from "node:crypto";
import { changePassword, GENERIC_LOGIN_ERROR, login, requestReset, resetPassword, sessionUser } from "./auth";
import { readStore, resetStore, updateStore } from "../lib/db/store";
import { clearDevOutbox, devOutbox } from "../lib/mailer";
import { AppError } from "../lib/errors";
import { captureLogs, testPassword } from "../test/support";

process.env.ACME_DATA_PATH = "memory";
const SEED_PASSWORD = testPassword();
process.env.ACME_SEED_PASSWORD = SEED_PASSWORD;
const logs = captureLogs();

const CUSTOMER = "customer@acme-retail.test";

async function rejectsWith(promise: Promise<unknown>, status: number, message?: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.status, status);
    if (message) assert.equal(error.message, message);
    return true;
  });
}

async function user(email: string) {
  return readStore((data) => data.users.find((item) => item.email === email)!);
}

test("seeded accounts have no hard-coded password and must change the initial one", async () => {
  await resetStore();
  await rejectsWith(login(CUSTOMER, "Retail123!"), 401, GENERIC_LOGIN_ERROR);
  const result = await login(CUSTOMER, SEED_PASSWORD);
  assert.equal(result.user.mustChangePassword, true);
  const stored = await user(CUSTOMER);
  assert.match(stored.passwordHash, /^scrypt\$ln=17,r=8,p=1\$/);
  const saved = process.env.ACME_SEED_PASSWORD;
  delete process.env.ACME_SEED_PASSWORD;
  await resetStore();
  assert.equal((await user(CUSTOMER)).passwordHash, "!unusable", "without ACME_SEED_PASSWORD no seeded account is usable");
  await rejectsWith(login(CUSTOMER, SEED_PASSWORD), 401);
  process.env.ACME_SEED_PASSWORD = saved;
  await resetStore();
});

test("five failed logins lock the account, the lock is persisted and back-off doubles", async () => {
  await resetStore();
  for (let i = 0; i < 5; i += 1) await rejectsWith(login(CUSTOMER, "Wrong-Password-81!"), 401, GENERIC_LOGIN_ERROR);
  let stored = await user(CUSTOMER);
  assert.ok(stored.lockedUntil && Date.parse(stored.lockedUntil) > Date.now(), "lockout must be persisted");
  const firstLock = Date.parse(stored.lockedUntil!) - Date.now();
  assert.ok(firstLock > 14 * 60_000 && firstLock <= 15 * 60_000);
  await rejectsWith(login(CUSTOMER, SEED_PASSWORD), 401, GENERIC_LOGIN_ERROR);
  const events = await readStore((data) => data.events.map((event) => event.type));
  assert.ok(events.includes("auth.locked") && events.filter((type) => type === "auth.failure").length >= 5, "failures and the lockout are recorded");
  await updateStore((data) => {
    data.users.find((item) => item.email === CUSTOMER)!.lockedUntil = new Date(Date.now() - 1000).toISOString();
  });
  for (let i = 0; i < 5; i += 1) await rejectsWith(login(CUSTOMER, "Wrong-Password-81!"), 401);
  stored = await user(CUSTOMER);
  const secondLock = Date.parse(stored.lockedUntil!) - Date.now();
  assert.ok(secondLock > 29 * 60_000 && secondLock <= 30 * 60_000, "second lockout lasts twice as long");
  assert.ok(logs.some((entry) => entry.type === "auth.lockout"));
});

test("unknown accounts and wrong passwords fail the same way and take similar time", async () => {
  await resetStore();
  const time = async (email: string) => {
    const started = performance.now();
    await rejectsWith(login(email, "Not-The-Pass-81!"), 401, GENERIC_LOGIN_ERROR);
    return performance.now() - started;
  };
  const known: number[] = [];
  const unknown: number[] = [];
  for (const email of ["customer@acme-retail.test", "catalog@acme-retail.test", "warehouse@acme-retail.test", "jordan.lee@acme-retail.test", "sam.patel@acme-retail.test"]) known.push(await time(email));
  for (let i = 0; i < 5; i += 1) unknown.push(await time(`nobody${i}@acme-retail.test`));
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[2];
  const ratio = median(unknown) / median(known);
  assert.ok(ratio > 0.6 && ratio < 1.6, `timing ratio ${ratio.toFixed(2)} reveals account existence`);
});

test("password reset goes only to the registered mailbox, stores no plaintext link and ends sessions", async () => {
  await resetStore();
  clearDevOutbox();
  const session = await login(CUSTOMER, SEED_PASSWORD);
  await requestReset(CUSTOMER, { ip: "198.51.100.7" });
  await requestReset("nobody@acme-retail.test");
  assert.equal(devOutbox().length, 1, "no mail for unknown accounts");
  const mail = devOutbox()[0];
  assert.equal(mail.to, CUSTOMER);
  assert.ok(!mail.text.includes(SEED_PASSWORD), "mail never contains a password");
  const token = /#token=([a-f0-9]+)/.exec(mail.text)?.[1];
  assert.ok(token, "link carries the token in the URL fragment");
  const snapshot = await readStore((data) => JSON.stringify(data));
  assert.ok(!snapshot.includes(token!), "the token is not persisted in clear text");
  assert.ok(!("mail" in (await readStore((data) => data))), "no mailbox is stored");
  const fresh = testPassword({ email: CUSTOMER, name: "Avery Chen" });
  await rejectsWith(resetPassword(token!, SEED_PASSWORD), 400, "Choose a password you have not used recently.");
  await resetPassword(token!, fresh);
  assert.equal(await sessionUser(session.token), null, "all sessions end after a reset");
  assert.equal(devOutbox()[0].subject, "Your ACME Retail password was changed");
  await rejectsWith(resetPassword(token!, testPassword()), 400, "This reset link is invalid or has expired.");
  const after = await login(CUSTOMER, fresh);
  assert.equal(after.user.mustChangePassword, false);
});

test("reset requests are throttled per account and older links stop working", async () => {
  await resetStore();
  clearDevOutbox();
  for (let i = 0; i < 5; i += 1) await requestReset(CUSTOMER);
  assert.equal(devOutbox().length, 3, "only three links per account per window");
  const tokens = devOutbox().map((item) => /#token=([a-f0-9]+)/.exec(item.text)![1]);
  await rejectsWith(resetPassword(tokens[2], testPassword()), 400, "This reset link is invalid or has expired.");
  await resetPassword(tokens[0], testPassword({ email: CUSTOMER, name: "Avery Chen" }));
});

test("password change requires the current password, the policy and no reuse", async () => {
  await resetStore();
  clearDevOutbox();
  const { user: actor, token } = await login(CUSTOMER, SEED_PASSWORD);
  await rejectsWith(changePassword(actor.id, "Wrong-Current-81!", testPassword()), 401, "Current password is incorrect.");
  await rejectsWith(changePassword(actor.id, SEED_PASSWORD, "Password-2024!"), 400);
  await rejectsWith(changePassword(actor.id, SEED_PASSWORD, SEED_PASSWORD), 400, "Choose a password you have not used recently.");
  const next = testPassword({ email: CUSTOMER, name: "Avery Chen" });
  await changePassword(actor.id, SEED_PASSWORD, next);
  assert.equal(await sessionUser(token), null);
  assert.equal(devOutbox()[0].to, CUSTOMER);
  const third = testPassword({ email: CUSTOMER, name: "Avery Chen" });
  const { user: again } = await login(CUSTOMER, next);
  await changePassword(again.id, next, third);
  const { user: last } = await login(CUSTOMER, third);
  await rejectsWith(changePassword(last.id, third, SEED_PASSWORD), 400, "Choose a password you have not used recently.");
  assert.equal((await user(CUSTOMER)).passwordHistory.length, 2);
});

test("legacy password hashes are upgraded at the next sign-in", async () => {
  await resetStore();
  const salt = randomBytes(16).toString("hex");
  const legacyPassword = testPassword();
  await updateStore((data) => {
    data.users.find((item) => item.email === CUSTOMER)!.passwordHash = `scrypt$${salt}$${scryptSync(legacyPassword, salt, 32).toString("hex")}`;
  });
  await login(CUSTOMER, legacyPassword);
  assert.match((await user(CUSTOMER)).passwordHash, /^scrypt\$ln=17,r=8,p=1\$/);
  await login(CUSTOMER, legacyPassword);
});

test("idle timeout: passive polling does not extend the session and 30 idle minutes end it", async () => {
  await resetStore();
  const { token } = await login(CUSTOMER, SEED_PASSWORD);
  const start = Date.now();
  mock.timers.enable({ apis: ["Date"], now: start });
  try {
    mock.timers.tick(20 * 60_000);
    assert.ok(await sessionUser(token, { touch: false }), "still valid after 20 minutes");
    mock.timers.tick(11 * 60_000);
    assert.equal(await sessionUser(token, { touch: false }), null, "passive checks never refreshed it");
    assert.equal(await sessionUser(token), null, "expired session is removed");
  } finally {
    mock.timers.reset();
  }
  const second = await login(CUSTOMER, SEED_PASSWORD);
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    mock.timers.tick(20 * 60_000);
    assert.ok(await sessionUser(second.token), "active use refreshes the idle timer");
    mock.timers.tick(20 * 60_000);
    assert.ok(await sessionUser(second.token, { touch: false }));
  } finally {
    mock.timers.reset();
  }
});

test("configurable password age: minimum age blocks rapid changes, maximum age forces a change", async () => {
  await resetStore();
  const { user: actor } = await login(CUSTOMER, SEED_PASSWORD);
  const first = testPassword({ email: CUSTOMER, name: "Avery Chen" });
  process.env.PASSWORD_MIN_AGE_HOURS = "24";
  try {
    await changePassword(actor.id, SEED_PASSWORD, first);
    const { user: again } = await login(CUSTOMER, first);
    await rejectsWith(changePassword(again.id, first, testPassword({ email: CUSTOMER, name: "Avery Chen" })), 400, "You changed your password recently. Try again later.");
  } finally {
    delete process.env.PASSWORD_MIN_AGE_HOURS;
  }
  process.env.PASSWORD_MAX_AGE_DAYS = "30";
  try {
    assert.equal((await login(CUSTOMER, first)).user.mustChangePassword, false);
    await updateStore((data) => {
      data.users.find((item) => item.email === CUSTOMER)!.passwordChangedAt = new Date(Date.now() - 31 * 86_400_000).toISOString();
    });
    assert.equal((await login(CUSTOMER, first)).user.mustChangePassword, true, "an expired password must be changed");
  } finally {
    delete process.env.PASSWORD_MAX_AGE_DAYS;
  }
});

test("reset links use the configured origin, never a request header", async () => {
  await resetStore();
  clearDevOutbox();
  process.env.APP_ORIGIN = "https://shop.example";
  try {
    await requestReset(CUSTOMER);
  } finally {
    delete process.env.APP_ORIGIN;
  }
  assert.match(devOutbox()[0].text, /https:\/\/shop\.example\/reset#token=[a-f0-9]{48}/);
});
