import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { readStore, saveLocalUpload, sweepTempFiles, TEMP_FILE_MAX_AGE_MS, updateStore } from "./store";
import { AppError } from "../errors";
import { captureLogs, testPassword } from "../../test/support";

// File mode in a throw-away working directory.
const workdir = mkdtempSync(path.join(tmpdir(), "acme-store-"));
process.chdir(workdir);
delete process.env.ACME_DATA_PATH;
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.ACME_SEED_PASSWORD = testPassword();
const logs = captureLogs();
const dataDir = path.join(workdir, ".data");
const dataFile = path.join(dataDir, "acme-retail.json");

function integrityError(error: unknown) {
  return error instanceof AppError && error.code === "integrity_error";
}

test("the data file is created owner-only and written atomically without leftover temp files", async () => {
  assert.equal(await readStore((data) => data.users.length), 7);
  for (let i = 0; i < 5; i += 1) await updateStore((data) => void (data.orderSeq += 1));
  assert.equal(await readStore((data) => data.orderSeq), 10065);
  assert.deepEqual(readdirSync(dataDir).filter((name) => name.endsWith(".tmp")), []);
  if (process.platform !== "win32") {
    assert.equal(statSync(dataFile).mode & 0o777, 0o600);
    assert.equal(statSync(dataDir).mode & 0o777, 0o700);
  }
});

test("a corrupted or tampered data file is refused, logged and never overwritten", async () => {
  writeFileSync(dataFile, "{ not json");
  await assert.rejects(readStore((data) => data.users.length), integrityError);
  assert.equal(readFileSync(dataFile, "utf8"), "{ not json", "the damaged file is kept for investigation");
  writeFileSync(dataFile, JSON.stringify({ version: 1, users: "everyone" }));
  await assert.rejects(updateStore((data) => data.users.length), integrityError);
  assert.ok(logs.some((entry) => entry.type === "data.integrity_failed"));
  rmSync(dataFile);
  assert.equal(await readStore((data) => data.users.length), 7, "a missing file is re-created from the seed");
});

test("a symbolic link in place of the data directory is refused", async () => {
  const elsewhere = path.join(workdir, "elsewhere");
  mkdirSync(elsewhere);
  rmSync(dataDir, { recursive: true, force: true });
  symlinkSync(elsewhere, dataDir, "junction");
  await assert.rejects(readStore((data) => data.users.length), integrityError);
  assert.deepEqual(readdirSync(elsewhere), [], "nothing is written through the link");
  assert.ok(logs.some((entry) => entry.type === "data.symlink_refused"));
  rmSync(dataDir, { recursive: true, force: true });
});

test("return photos are written owner-only, never overwrite and reject unsafe names", async () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]);
  await saveLocalUpload("usr_01-0123456789abcdef.png", bytes);
  await assert.rejects(saveLocalUpload("usr_01-0123456789abcdef.png", bytes), (error: NodeJS.ErrnoException) => error.code === "EEXIST");
  await assert.rejects(saveLocalUpload("../escape.png", bytes), AppError);
  if (process.platform !== "win32") {
    assert.equal(statSync(path.join(dataDir, "uploads", "usr_01-0123456789abcdef.png")).mode & 0o777, 0o600);
  }
});

test("snapshots from before per-account passwords lose the shared demo password, mailbox and sessions", async () => {
  rmSync(dataDir, { recursive: true, force: true });
  const current = await readStore((data) => data);
  const legacy = {
    ...current,
    users: current.users.map((user) => {
      const copy: Record<string, unknown> = { ...user, passwordHash: "scrypt$00$11" };
      for (const key of ["passwordChangedAt", "mustChangePassword", "passwordHistory", "lastFailedAt", "lockouts", "lastLoginAt"]) delete copy[key];
      return copy;
    }),
    sessions: [{ id: "s1", userId: "usr_01", tokenHash: "x", createdAt: "", expiresAt: "2999-01-01T00:00:00.000Z", lastSeenAt: "2999-01-01T00:00:00.000Z" }],
    mail: [{ id: "m1", to: "customer@acme-retail.test", subject: "Reset", body: "/reset?token=abc", createdAt: "", sessionKey: "k" }],
  };
  writeFileSync(dataFile, JSON.stringify(legacy));
  const loaded = await readStore((data) => data);
  assert.ok(loaded.users.every((user) => user.passwordHash === "!unusable" && user.mustChangePassword));
  assert.deepEqual(loaded.sessions, []);
  assert.equal("mail" in loaded, false);
  await updateStore((data) => void (data.orderSeq += 1));
  assert.ok(!readFileSync(dataFile, "utf8").includes("/reset?token="), "plaintext reset links are purged from disk");
});

test("hard-linked data files are refused and stale temp files are swept", async () => {
  rmSync(dataDir, { recursive: true, force: true });
  assert.equal(await readStore((data) => data.users.length), 7);
  const outside = path.join(workdir, "outside-copy.json");
  linkSync(dataFile, outside);
  await assert.rejects(readStore((data) => data.users.length), integrityError);
  rmSync(outside);
  assert.equal(await readStore((data) => data.users.length), 7, "works again once the extra link is gone");
  const stale = path.join(dataDir, "acme-retail.json.0123456789ab.tmp");
  const fresh = path.join(dataDir, "acme-retail.json.ba9876543210.tmp");
  writeFileSync(stale, "{}");
  writeFileSync(fresh, "{}");
  const old = new Date(Date.now() - TEMP_FILE_MAX_AGE_MS - 60_000);
  utimesSync(stale, old, old);
  assert.equal(await sweepTempFiles(), 1);
  assert.deepEqual(readdirSync(dataDir).filter((name) => name.endsWith(".tmp")), ["acme-retail.json.ba9876543210.tmp"]);
  rmSync(fresh);
});

test("with a data key the snapshot and return photos are encrypted on disk and still load", async () => {
  rmSync(dataDir, { recursive: true, force: true });
  process.env.ACME_DATA_KEYS = `k1:${randomBytes(32).toString("base64")}`;
  try {
    assert.equal(await readStore((data) => data.users.length), 7);
    await updateStore((data) => void (data.orderSeq += 1));
    const raw = readFileSync(dataFile, "utf8");
    assert.equal(JSON.parse(raw).enc, "aes-256-gcm");
    for (const plain of ["customer@acme-retail.test", "Avery Chen", "Market Street", "passwordHash"]) assert.ok(!raw.includes(plain), `${plain} is not stored in clear`);
    assert.equal(await readStore((data) => data.orderSeq), 10061, "the application reads the data transparently");
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]);
    await saveLocalUpload("usr_01-fedcba9876543210.png", png);
    const stored = readFileSync(path.join(dataDir, "uploads", "usr_01-fedcba9876543210.png"));
    assert.ok(!stored.subarray(0, 4).equals(Buffer.from(png.subarray(0, 4))), "photos are sealed too");
  } finally {
    delete process.env.ACME_DATA_KEYS;
  }
});

test("a plain snapshot from before encryption is sealed on the next write; another key cannot open it", async () => {
  rmSync(dataDir, { recursive: true, force: true });
  assert.equal(await readStore((data) => data.users.length), 7);
  assert.ok(readFileSync(dataFile, "utf8").includes("customer@acme-retail.test"), "development without a key stays plain");
  process.env.ACME_DATA_KEYS = `k1:${randomBytes(32).toString("base64")}`;
  try {
    await updateStore((data) => void (data.orderSeq += 1));
    assert.equal(JSON.parse(readFileSync(dataFile, "utf8")).enc, "aes-256-gcm");
    process.env.ACME_DATA_KEYS = `k1:${randomBytes(32).toString("base64")}`;
    await assert.rejects(readStore((data) => data.users.length), integrityError);
    assert.ok(logs.some((entry) => entry.type === "data.decrypt_failed"));
  } finally {
    delete process.env.ACME_DATA_KEYS;
    rmSync(dataDir, { recursive: true, force: true });
  }
  assert.equal(await readStore((data) => data.users.length), 7, "a fresh plain store for the next test");
});

test("data files readable by other users are narrowed to owner-only (POSIX)", async () => {
  if (process.platform === "win32") return; // NTFS uses ACLs; mode bits do not apply.
  chmodSync(dataFile, 0o644);
  await readStore((data) => data.users.length);
  assert.equal(statSync(dataFile).mode & 0o777, 0o600);
  assert.ok(logs.some((entry) => entry.type === "data.permissions_repaired"));
});
