import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AppError } from "./errors";
import { securityLog } from "./security-log";
import { dataKeys } from "./keys";

/**
 * Encryption at rest (SD Elements T295). The persisted snapshot (local file and Supabase jsonb) and
 * stored return photos are sealed with AES-256-GCM: a random 96-bit IV per write, a 128-bit
 * authentication tag and associated data that binds each ciphertext to its purpose. The active key
 * is the first entry of ACME_DATA_KEYS; older key ids still open data until it is rewritten, which
 * lets keys rotate without downtime (see src/lib/keys.ts). Wrappers around storage and retrieval
 * keep the encryption transparent for the rest of the application.
 */
type Env = Record<string, string | undefined>;

export const SNAPSHOT_AAD = "acme-retail:snapshot:v1";
export const UPLOAD_AAD = "acme-retail:upload:v1";
const BYTES_MAGIC = Buffer.from("ACME1");

export interface SealedText {
  enc: "aes-256-gcm";
  kid: string;
  iv: string;
  tag: string;
  data: string;
}

interface Sealed {
  kid: string;
  iv: Buffer;
  tag: Buffer;
  data: Buffer;
}

export function isSealed(value: unknown): value is SealedText {
  const item = value as Partial<SealedText> | null;
  return !!item && typeof item === "object" && item.enc === "aes-256-gcm" && typeof item.kid === "string" && typeof item.iv === "string" && typeof item.tag === "string" && typeof item.data === "string";
}

function integrityError(detail: string): AppError {
  securityLog({ type: "data.decrypt_failed", outcome: "failure", detail });
  return new AppError("Stored data failed an integrity check. Contact support.", 500, "integrity_error");
}

/** True when data is encrypted before it is written (a key is configured). */
export function encryptionEnabled(env: Env = process.env): boolean {
  return dataKeys(env).length > 0;
}

let warned = false;

/**
 * Production never writes personal data unencrypted: without ACME_DATA_KEYS the write is refused.
 * Outside production local data stays plain for development (logged once).
 */
export function assertEncryptionAvailable(env: Env = process.env) {
  if (encryptionEnabled(env)) return;
  if (env.NODE_ENV === "production") {
    securityLog({ type: "data.key_missing", outcome: "blocked", detail: "ACME_DATA_KEYS is not set; refusing to write unencrypted data." });
    throw new AppError("The store is not configured. Contact support.", 503, "unavailable");
  }
  if (!warned) {
    warned = true;
    securityLog({ type: "data.unencrypted", outcome: "info", detail: "ACME_DATA_KEYS is not set; local data is stored unencrypted (development only)." });
  }
}

function encrypt(plain: Buffer, aad: string, env: Env): Sealed {
  const [active] = dataKeys(env);
  if (!active) throw new AppError("The store is not configured. Contact support.", 503, "unavailable");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", active.key, iv);
  cipher.setAAD(Buffer.from(aad));
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { kid: active.id, iv, tag: cipher.getAuthTag(), data };
}

function decrypt(sealed: Sealed, aad: string, env: Env): Buffer {
  const key = dataKeys(env).find((item) => item.id === sealed.kid);
  if (!key) throw integrityError(`no key with id ${sealed.kid}`);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key.key, sealed.iv);
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(sealed.tag);
    return Buffer.concat([decipher.update(sealed.data), decipher.final()]);
  } catch {
    throw integrityError("authentication failed");
  }
}

export function sealText(text: string, aad: string, env: Env = process.env): SealedText {
  const sealed = encrypt(Buffer.from(text, "utf8"), aad, env);
  return { enc: "aes-256-gcm", kid: sealed.kid, iv: sealed.iv.toString("base64"), tag: sealed.tag.toString("base64"), data: sealed.data.toString("base64") };
}

export function openText(sealed: SealedText, aad: string, env: Env = process.env): string {
  return decrypt({ kid: sealed.kid, iv: Buffer.from(sealed.iv, "base64"), tag: Buffer.from(sealed.tag, "base64"), data: Buffer.from(sealed.data, "base64") }, aad, env).toString("utf8");
}

/** Binary form for files: "ACME1" | kid length | kid | IV (12) | tag (16) | ciphertext. */
export function sealBytes(bytes: Uint8Array, aad: string, env: Env = process.env): Buffer {
  const sealed = encrypt(Buffer.from(bytes), aad, env);
  const kid = Buffer.from(sealed.kid);
  return Buffer.concat([BYTES_MAGIC, Buffer.from([kid.length]), kid, sealed.iv, sealed.tag, sealed.data]);
}

export function isSealedBytes(buffer: Uint8Array): boolean {
  return Buffer.from(buffer.subarray(0, BYTES_MAGIC.length)).equals(BYTES_MAGIC);
}

export function openBytes(buffer: Buffer, aad: string, env: Env = process.env): Buffer {
  if (!isSealedBytes(buffer)) throw integrityError("not a sealed file");
  const kidLength = buffer[BYTES_MAGIC.length];
  const start = BYTES_MAGIC.length + 1;
  const kid = buffer.subarray(start, start + kidLength).toString();
  const offset = start + kidLength;
  return decrypt({ kid, iv: buffer.subarray(offset, offset + 12), tag: buffer.subarray(offset + 12, offset + 28), data: buffer.subarray(offset + 28) }, aad, env);
}
