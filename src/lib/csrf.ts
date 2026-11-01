import { createHmac, randomBytes } from "node:crypto";
import { safeEqual } from "./security";

/**
 * Anti-CSRF tokens (SD Elements T29), modelled on the `csrf` token library used by csurf:
 * - a per-browser secret (256 bits from the CSPRNG) lives only in an HttpOnly, Secure,
 *   SameSite=Strict `__Host-` cookie;
 * - each token is a random salt plus HMAC-SHA256(secret, salt), so tokens differ on every issue
 *   (no fixed value for compression side channels) and cannot be forged without the secret;
 * - the token is independent of the session id: it is derived from its own secret, never from
 *   the session cookie;
 * - pages send the token in the X-CSRF-Token header and every state-changing API request is
 *   verified against the cookie (guardMutation in src/lib/http.ts);
 * - the secret is replaced at sign-in and removed at sign-out, so a token obtained before a
 *   change of identity stops working.
 */
export const CSRF_COOKIE = "__Host-acme_csrf";
export const CSRF_HEADER = "x-csrf-token";

const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SALT_PATTERN = /^[A-Za-z0-9_-]{16}$/;

export function createCsrfSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function isCsrfSecret(value: unknown): value is string {
  return typeof value === "string" && SECRET_PATTERN.test(value);
}

function sign(secret: string, salt: string): string {
  return createHmac("sha256", secret).update(`acme-csrf-v1:${salt}`).digest("base64url");
}

export function createCsrfToken(secret: string): string {
  const salt = randomBytes(12).toString("base64url");
  return `${salt}.${sign(secret, salt)}`;
}

/** Verifies a token against the secret from the cookie (constant-time comparison). */
export function verifyCsrfToken(secret: string | undefined, token: string | null): boolean {
  if (!isCsrfSecret(secret) || !token || token.length > 100) return false;
  const parts = token.split(".");
  if (parts.length !== 2 || !SALT_PATTERN.test(parts[0]) || !parts[1]) return false;
  return safeEqual(sign(secret, parts[0]), parts[1]);
}
