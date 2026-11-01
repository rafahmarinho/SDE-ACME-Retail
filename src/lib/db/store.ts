import { chmod, lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { buildSeed } from "../seed";
import type { StoreData, User } from "../types";
import { AppError } from "../errors";
import { UNUSABLE_PASSWORD } from "../security";
import { dbLog, securityLog } from "../security-log";
import { describeChanges, fingerprint } from "./activity-log";
import { MAX_SNAPSHOT_BYTES } from "../query-limits";
import { AUDIT_RETENTION } from "../audit";
import { assertEncryptionAvailable, encryptionEnabled, isSealed, openText, sealBytes, sealText, SNAPSHOT_AAD, UPLOAD_AAD } from "../data-crypto";
import { loadSupabaseState, saveSupabaseState } from "./supabase-state";

const dataDir = () => (process.env.ACME_DATA_DIR ? path.resolve(process.env.ACME_DATA_DIR) : path.join(process.cwd(), ".data"));
const dataPath = () => path.join(dataDir(), "acme-retail.json");

let chain: Promise<unknown> = Promise.resolve();
let memory: StoreData | null = null;

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function supabaseMode() {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) && process.env.ACME_DATA_PATH !== "memory";
}

const COLLECTIONS: (keyof StoreData)[] = [
  "users", "addresses", "products", "variants", "coupons", "carts", "wishlists", "orders", "reservations",
  "checkouts", "returns", "refunds", "events", "resetTokens", "sessions",
];

/** Structural integrity check of a loaded snapshot. Throws instead of silently re-seeding. */
export function assertStoreShape(value: unknown): asserts value is StoreData {
  const data = value as Partial<StoreData> | null;
  const valid =
    !!data &&
    typeof data === "object" &&
    typeof data.version === "number" &&
    typeof data.orderSeq === "number" &&
    !!data.settings &&
    COLLECTIONS.every((key) => Array.isArray(data[key])) &&
    (data.users ?? []).every((user) => typeof user?.id === "string" && typeof user?.email === "string" && typeof user?.passwordHash === "string");
  if (!valid) {
    securityLog({ type: "data.integrity_failed", outcome: "failure", detail: "The data snapshot failed its integrity check; it was not loaded or overwritten." });
    throw new AppError("Stored data failed an integrity check. Contact support.", 500, "integrity_error");
  }
}

/**
 * Result-set limit of the database itself: a snapshot larger than MAX_SNAPSHOT_BYTES is neither
 * loaded into the application nor saved (the transaction is rolled back), see src/lib/query-limits.ts.
 */
export function assertSnapshotSize(serialized: string, operation: "load" | "save") {
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > MAX_SNAPSHOT_BYTES) {
    securityLog({ type: "query.result_too_large", outcome: "blocked", detail: `snapshot ${operation}: ${bytes} bytes exceed the limit of ${MAX_SNAPSHOT_BYTES}` });
    throw new AppError("The store has reached its size limit. Contact support.", 507, "store_too_large");
  }
}

/**
 * Transparent encryption at rest (T295): snapshots are sealed with the active data key before they
 * are written and opened after they are read; plain snapshots from before encryption still load
 * and are sealed on the next write.
 */
function encodeSnapshot(serialized: string): { text: string; sealed: ReturnType<typeof sealText> | null } {
  assertEncryptionAvailable();
  if (!encryptionEnabled()) return { text: serialized, sealed: null };
  const sealed = sealText(serialized, SNAPSHOT_AAD);
  return { text: JSON.stringify(sealed), sealed };
}

function decodeSnapshot(value: unknown): unknown {
  if (!isSealed(value)) return value;
  try {
    return JSON.parse(openText(value, SNAPSHOT_AAD));
  } catch (error) {
    if (error instanceof AppError) throw error;
    return null;
  }
}

/**
 * Fills fields added after older snapshots were written and drops data that must not be kept.
 * Accounts from snapshots written before passwords were managed per account still carry the old
 * shared demo password: that password is disabled, their sessions end, and a new password must be
 * set through the e-mailed reset link (or by re-seeding with ACME_SEED_PASSWORD).
 */
function normalize(data: StoreData): StoreData {
  const legacy = data as StoreData & { mail?: unknown };
  delete legacy.mail;
  data.uploads ??= [];
  data.privacy ??= [];
  data.consentLog ??= [];
  data.throttle ??= [];
  data.challenges ??= [];
  const migrated = new Set<string>();
  data.users = data.users.map((user: User) => {
    const old = user.passwordChangedAt === undefined;
    if (old) migrated.add(user.id);
    // The old marketing checkbox carried no proof of consent (notice version, time, session), so it is
    // not carried over: product update e-mails need a fresh opt-in through the consent form.
    const { marketingOptIn: _legacyOptIn, ...rest } = user as User & { marketingOptIn?: boolean };
    void _legacyOptIn;
    return {
      ...rest,
      passwordHash: old ? UNUSABLE_PASSWORD : user.passwordHash,
      lastFailedAt: user.lastFailedAt ?? null,
      lockouts: user.lockouts ?? 0,
      mustChangePassword: old ? true : (user.mustChangePassword ?? false),
      passwordChangedAt: user.passwordChangedAt ?? null,
      passwordHistory: user.passwordHistory ?? [],
      lastLoginAt: user.lastLoginAt ?? null,
      mfa: user.mfa ?? null,
      mfaPending: user.mfaPending ?? null,
    };
  });
  if (migrated.size) data.sessions = data.sessions.filter((session) => !migrated.has(session.userId));
  data.sessions = data.sessions.map((session) => ({ ...session, stepUpAt: session.stepUpAt ?? null }));
  data.resetTokens = data.resetTokens.map((token) => ({ ...token, createdAt: token.createdAt ?? token.expiresAt }));
  return data;
}

/**
 * Refuses symbolic links (and junctions) and hard-linked files before opening application data,
 * and narrows permissions that are wider than owner-only (POSIX; Windows uses ACLs).
 */
async function refuseSymlink(target: string) {
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1)) {
    securityLog({ type: "data.symlink_refused", outcome: "blocked", detail: `${path.basename(target)} is a link` });
    throw new AppError("Refusing to use a linked path for application data.", 500, "integrity_error");
  }
  const wanted = info.isDirectory() ? 0o700 : 0o600;
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    await chmod(target, wanted);
    securityLog({ type: "data.permissions_repaired", outcome: "info", detail: `${path.basename(target)} was readable by others` });
  }
}

/** Temp files older than this are leftovers of interrupted writes and are deleted. */
export const TEMP_FILE_MAX_AGE_MS = 10 * 60_000;
let lastSweep = 0;

/** Watchdog for the data directory: removes stale temp files according to TEMP_FILE_MAX_AGE_MS. */
export async function sweepTempFiles(now = Date.now()): Promise<number> {
  lastSweep = now;
  let names: string[];
  try {
    names = await readdir(dataDir());
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!/^acme-retail\.json\.[0-9a-f]{12}\.tmp$/.test(name)) continue;
    const full = path.join(dataDir(), name);
    const info = await lstat(full).catch(() => null);
    if (info && info.isFile() && now - info.mtimeMs > TEMP_FILE_MAX_AGE_MS) {
      await unlink(full).catch(() => undefined);
      removed += 1;
    }
  }
  if (removed) securityLog({ type: "data.temp_removed", outcome: "info", detail: `${removed} stale temp file(s) removed` });
  return removed;
}

async function replaceFile(temp: string, file: string) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temp, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code === "EPERM" || code === "EBUSY" || code === "EACCES") && attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
}

/**
 * Writes the snapshot atomically: a new owner-only temp file (created exclusively, so a planted
 * link is never followed) is renamed over the data file, which also removes the temp file.
 */
export async function writeFileAtomic(file: string, contents: string) {
  const dir = path.dirname(file);
  await refuseSymlink(dir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await refuseSymlink(file);
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await replaceFile(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

async function loadFile(): Promise<StoreData> {
  const file = dataPath();
  await refuseSymlink(dataDir());
  await refuseSymlink(file);
  if (Date.now() - lastSweep > 60_000) await sweepTempFiles();
  let raw: string;
  try {
    raw = await readFile(/*turbopackIgnore: true*/ file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const seed = await buildSeed();
    await writeFileAtomic(file, encodeSnapshot(JSON.stringify(seed)).text);
    return seed;
  }
  assertSnapshotSize(raw, "load");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  parsed = decodeSnapshot(parsed);
  assertStoreShape(parsed);
  return normalize(parsed);
}

async function load(): Promise<StoreData> {
  if (process.env.ACME_DATA_PATH === "memory") {
    memory ??= await buildSeed();
    return structuredClone(memory);
  }
  if (supabaseMode()) {
    const stored = await loadSupabaseState();
    if (stored) {
      assertSnapshotSize(JSON.stringify(stored), "load");
      const remote = decodeSnapshot(stored);
      assertStoreShape(remote);
      return normalize(remote);
    }
    const seed = await buildSeed();
    await saveSupabaseState(seed, encodeSnapshot(JSON.stringify(seed)).sealed);
    return seed;
  }
  return loadFile();
}

async function persist(data: StoreData): Promise<void> {
  const serialized = JSON.stringify(data);
  assertSnapshotSize(serialized, "save");
  if (process.env.ACME_DATA_PATH === "memory") {
    memory = data;
    return;
  }
  const encoded = encodeSnapshot(serialized);
  if (supabaseMode()) {
    await saveSupabaseState(data, encoded.sealed);
    return;
  }
  await writeFileAtomic(dataPath(), encoded.text);
}

export async function readStore<T>(fn: (data: StoreData) => T): Promise<T> {
  return enqueue(async () => fn(structuredClone(await load())));
}

/**
 * One store transaction: load, apply, persist. A commit is logged with the records and fields that
 * changed; an error in the callback or while saving rolls the transaction back (nothing is saved)
 * and is logged with its reason (T2602).
 */
export async function updateStore<T>(fn: (data: StoreData) => T): Promise<T> {
  return enqueue(async () => {
    const txId = randomUUID();
    const started = Date.now();
    const data = await load();
    const before = fingerprint(data);
    try {
      const result = fn(data);
      await persist(data);
      const changes = describeChanges(before, data);
      if (changes.length) dbLog({ type: "db.commit", outcome: "success", txId, durationMs: Date.now() - started, detail: changes.join("; ") });
      return result;
    } catch (error) {
      const reason = error instanceof AppError ? `${error.status} ${error.code}` : error instanceof Error ? error.name : "error";
      dbLog({ type: "db.rollback", outcome: "failure", txId, durationMs: Date.now() - started, detail: reason });
      throw error;
    }
  });
}

/**
 * Restores the seed catalog, accounts and orders. The audit trail and the shared rate-limit
 * counters are kept, so a reset cannot hide earlier actions or lift a throttle.
 */
export async function resetStore(): Promise<void> {
  const seed = await buildSeed();
  await updateStore((data) => {
    const events = data.events;
    const throttle = data.throttle ?? [];
    Object.assign(data, structuredClone(seed));
    data.events = [...seed.events, ...events].slice(0, AUDIT_RETENTION);
    data.throttle = throttle;
  });
}

/** Return photo bytes as stored (sealed when a data key is configured) and the content type to store them with. */
export function sealUpload(bytes: Uint8Array, contentType: string): { body: Uint8Array; contentType: string } {
  assertEncryptionAvailable();
  if (!encryptionEnabled()) return { body: bytes, contentType };
  return { body: sealBytes(bytes, UPLOAD_AAD), contentType: "application/octet-stream" };
}

/** Stores a return photo under .data/uploads with owner-only permissions, never following links (sealed when a key is set). */
export async function saveLocalUpload(objectName: string, bytes: Uint8Array) {
  if (!/^[A-Za-z0-9_-]+\.(png|jpg|webp)$/.test(objectName)) throw new AppError("Invalid file name.", 400, "bad_request");
  const dir = path.join(dataDir(), "uploads");
  await refuseSymlink(dataDir());
  await refuseSymlink(dir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(dir, objectName), sealUpload(bytes, "").body, { mode: 0o600, flag: "wx" });
}
