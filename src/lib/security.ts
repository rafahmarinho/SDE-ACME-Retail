import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash, createHmac, type ScryptOptions } from "node:crypto";
import { AppError } from "./errors";
import { securityConfig, type SecurityConfig } from "./config";
import { COMMON_PASSWORD_WORDS } from "./password-blocklist";
import type { ThrottleCounter } from "./types";

function scrypt(secret: string, salt: string, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(secret, salt, keylen, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/**
 * Password hashing parameters. scrypt with N=2^17, r=8, p=1 is the OWASP Password Storage Cheat
 * Sheet minimum. The parameters are stored with every hash ("scrypt$ln=17,r=8,p=1$salt$hash"), so
 * they can be raised later; hashes made with older parameters are upgraded at the next sign-in.
 */
export const SCRYPT_PARAMS = { ln: 17, r: 8, p: 1, keylen: 32, saltBytes: 16 } as const;
const LEGACY_PARAMS = { ln: 14, r: 8, p: 1, keylen: 32 } as const;
const CURRENT_PREFIX = `scrypt$ln=${SCRYPT_PARAMS.ln},r=${SCRYPT_PARAMS.r},p=${SCRYPT_PARAMS.p}$`;

/** Marker stored for accounts that have no usable password yet. Never verifies. */
export const UNUSABLE_PASSWORD = "!unusable";

function kdfOptions(ln: number, r: number, p: number): ScryptOptions {
  const N = 2 ** ln;
  return { N, r, p, maxmem: 256 * N * r };
}

async function derive(secret: string, salt: string, params: { ln: number; r: number; p: number; keylen: number }) {
  return scrypt(secret, salt, params.keylen, kdfOptions(params.ln, params.r, params.p));
}

export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(SCRYPT_PARAMS.saltBytes).toString("hex");
  const hash = await derive(secret, salt, SCRYPT_PARAMS);
  return `${CURRENT_PREFIX}${salt}$${hash.toString("hex")}`;
}

function parseHash(encoded: string) {
  const parts = encoded.split("$");
  if (parts.length === 3 && parts[0] === "scrypt") {
    return { params: LEGACY_PARAMS, salt: parts[1], hash: parts[2] };
  }
  if (parts.length === 4 && parts[0] === "scrypt") {
    const match = /^ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})$/.exec(parts[1]);
    if (!match) return null;
    const [ln, r, p] = match.slice(1).map(Number);
    if (ln < 14 || ln > 20 || r < 1 || r > 16 || p < 1 || p > 16) return null;
    return { params: { ln, r, p, keylen: SCRYPT_PARAMS.keylen }, salt: parts[2], hash: parts[3] };
  }
  return null;
}

let dummyHash: Promise<string> | null = null;

/** A hash of a random secret, used so unknown or disabled accounts cost the same KDF time. */
export function timingDummyHash(): Promise<string> {
  dummyHash ??= hashSecret(randomBytes(16).toString("hex"));
  return dummyHash;
}

export async function verifySecret(secret: string, encoded: string): Promise<boolean> {
  const parsed = parseHash(encoded);
  if (!parsed || !parsed.salt || !parsed.hash) {
    const dummy = parseHash(await timingDummyHash());
    if (dummy) await derive(secret, dummy.salt, dummy.params);
    return false;
  }
  const actual = await derive(secret, parsed.salt, parsed.params);
  const expected = Buffer.from(parsed.hash, "hex");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** True when a stored hash was made with weaker or different parameters than the current ones. */
export function needsRehash(encoded: string): boolean {
  return encoded !== UNUSABLE_PASSWORD && !encoded.startsWith(CURRENT_PREFIX);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

const LEET: Record<string, string> = { "@": "a", "4": "a", "3": "e", "1": "i", "!": "i", "|": "i", "0": "o", "$": "s", "5": "s", "7": "t", "+": "t", "8": "b", "9": "g" };

/** Letters-only form of a password: lower-case, common substitutions undone, decoration removed. */
export function passwordBase(password: string): string {
  const trimmed = password.toLowerCase().replace(/^[^a-z@$|!]+/, "").replace(/[^a-z]+$/, "");
  return [...trimmed].map((char) => LEET[char] ?? char).join("").replace(/[^a-z]/g, "");
}

function hasRunOrSequence(password: string): boolean {
  const lower = password.toLowerCase();
  for (let i = 0; i + 3 < lower.length; i += 1) {
    const codes = [...lower.slice(i, i + 4)].map((char) => char.charCodeAt(0));
    const same = codes.every((code) => code === codes[0]);
    const up = codes.every((code, index) => index === 0 || code === codes[index - 1] + 1);
    const down = codes.every((code, index) => index === 0 || code === codes[index - 1] - 1);
    const alnum = /^[a-z0-9]{4}$/.test(lower.slice(i, i + 4));
    if (same || (alnum && (up || down))) return true;
  }
  return false;
}

export interface PasswordContext {
  email?: string;
  name?: string;
}

function contextWords(context: PasswordContext): string[] {
  const words = new Set(["acme", "retail"]);
  const local = (context.email ?? "").toLowerCase().split("@")[0] ?? "";
  for (const part of local.split(/[^a-z0-9]+/)) if (part.length >= 3) words.add(part);
  for (const part of (context.name ?? "").toLowerCase().split(/[^a-z]+/)) if (part.length >= 3) words.add(part);
  return [...words];
}

/**
 * Password policy (NIST SP 800-63B and the configured complexity): length, character classes,
 * common and breached passwords, dictionary words, repeated or sequential characters and
 * context-specific words such as the user's name or e-mail. Reuse of recent passwords is checked
 * separately against the stored history.
 */
export function passwordIssues(password: string, context: PasswordContext = {}, config: SecurityConfig = securityConfig()): string[] {
  const issues: string[] = [];
  if (password.length < config.passwordMinLength) issues.push(`Use at least ${config.passwordMinLength} characters.`);
  if (password.length > config.passwordMaxLength) issues.push(`Use at most ${config.passwordMaxLength} characters.`);
  if (config.passwordClasses.includes("lower") && !/[a-z]/.test(password)) issues.push("Include a lowercase letter.");
  if (config.passwordClasses.includes("upper") && !/[A-Z]/.test(password)) issues.push("Include an uppercase letter.");
  if (config.passwordClasses.includes("digit") && !/[0-9]/.test(password)) issues.push("Include a digit.");
  if (config.passwordClasses.includes("symbol") && !/[^A-Za-z0-9]/.test(password)) issues.push("Include a symbol.");
  const base = passwordBase(password);
  const blocked = [...COMMON_PASSWORD_WORDS, ...config.passwordBlocklist];
  const common =
    base.length < 4 ||
    blocked.some((word) => base === word || (word.length >= 4 && base.includes(word) && base.length - word.length < 4));
  if (common) issues.push("Avoid common passwords and dictionary words.");
  if (hasRunOrSequence(password)) issues.push("Avoid repeated or sequential characters.");
  if (contextWords(context).some((word) => base.includes(word) || password.toLowerCase().includes(word))) {
    issues.push("Do not use your name, e-mail or the store name.");
  }
  return issues;
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string,
  toleranceSeconds = 300,
): boolean {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(
    header.split(",").map((part) => {
      const [key, value] = part.split("=");
      return [key, value];
    }),
  );
  const timestamp = Number(parts.t);
  const signature = parts.v1;
  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${payload}`)
    .digest("hex");
  return safeEqual(expected, signature);
}

const attempts = new Map<string, { count: number; resetAt: number }>();
let calls = 0;

function prune(now: number) {
  for (const [key, value] of attempts) {
    if (value.resetAt < now) attempts.delete(key);
  }
}

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  calls += 1;
  if (calls % 500 === 0 || attempts.size > 10_000) prune(now);
  const current = attempts.get(key);
  if (!current || current.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (current.count >= limit) return false;
  current.count += 1;
  return true;
}

export function resetRateLimits() {
  attempts.clear();
}

/** Most counters kept in the shared store; the oldest are dropped first. */
export const SHARED_COUNTER_LIMIT = 5000;

/**
 * Shared, durable rate limit (fixed window) over counters kept in the data store, so every server
 * instance sees the same counts and a restart or cold start does not reset them. Keys are hashed:
 * the store never holds raw IP addresses or e-mail addresses.
 */
export function sharedRateLimit(counters: ThrottleCounter[], key: string, limit: number, windowMs: number, now = Date.now()): { allowed: boolean; counters: ThrottleCounter[] } {
  const hashed = sha256(`throttle:${key}`).slice(0, 32);
  let next = counters.filter((item) => Date.parse(item.resetAt) > now);
  let current = next.find((item) => item.key === hashed);
  if (!current) {
    current = { key: hashed, count: 0, resetAt: new Date(now + windowMs).toISOString() };
    next.push(current);
    if (next.length > SHARED_COUNTER_LIMIT) next = next.slice(next.length - SHARED_COUNTER_LIMIT);
  }
  if (current.count >= limit) return { allowed: false, counters: next };
  current.count += 1;
  return { allowed: true, counters: next };
}

export function rateLimitEntries() {
  return attempts.size;
}

export function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const raw = forwarded || headers.get("x-real-ip") || "local";
  return raw.slice(0, 64).replace(/[^0-9a-fA-F:.]/g, "") || "local";
}

function forbidden(message: string): AppError {
  return new AppError(message, 403, "forbidden");
}

/**
 * CSRF defense chosen with the SD Elements T1541 flowchart: the API accepts state changes only
 * from same-origin fetch requests that a form cannot send (JSON or a custom header, which needs a
 * CORS preflight that this API never grants), checks Fetch Metadata and a mandatory Origin header,
 * and keeps the SameSite=Lax session cookie.
 */
export function assertSameOrigin(request: Request, appOrigin: string | null = securityConfig().appOrigin): void {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") throw forbidden("Cross-site request blocked.");
  const origin = request.headers.get("origin");
  if (!origin) throw forbidden("Missing origin.");
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw forbidden("Invalid origin.");
  }
  if (appOrigin) {
    if (parsed.origin !== appOrigin) throw forbidden("Origin does not match this site.");
    return;
  }
  const host = request.headers.get("host");
  if (!host || parsed.host !== host) throw forbidden("Origin does not match this site.");
}

export const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export function sanitizeText(value: string, max = 200): string {
  return value
    .replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g, "")
    .trim()
    .slice(0, max);
}

export type ImageType = "png" | "jpg" | "webp";

export function detectImageType(bytes: Uint8Array): ImageType | null {
  if (bytes.byteLength < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  const riff = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
  const webp = bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  return riff && webp ? "webp" : null;
}

const EXTENSIONS: Record<ImageType, string[]> = { png: [".png"], jpg: [".jpg", ".jpeg"], webp: [".webp"] };

export const IMAGE_CONTENT_TYPES: Record<ImageType, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

export function isAllowedImage(bytes: Uint8Array, name: string): boolean {
  const type = detectImageType(bytes);
  if (!type || bytes.byteLength > 2_000_000) return false;
  const lower = name.toLowerCase();
  return EXTENSIONS[type].some((ext) => lower.endsWith(ext));
}
