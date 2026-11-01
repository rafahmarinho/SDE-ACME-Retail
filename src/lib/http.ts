import { NextResponse } from "next/server";
import { AppError, toErrorResponse } from "./errors";
import { assertSameOrigin, clientIp, CONTROL_CHARS, randomToken, rateLimit, sharedRateLimit } from "./security";
import { updateStore } from "./db/store";
import { sessionUser, stepUpStatus } from "../services/auth";
import type { PublicUser } from "./types";
import { allows, type ApiRoute, type Permission, can, requiresSecondFactor, stepUpRequired } from "./policy";
import { securityLog } from "./security-log";
import { securityConfig } from "./config";
import { createCsrfSecret, createCsrfToken, CSRF_COOKIE, CSRF_HEADER, isCsrfSecret, verifyCsrfToken } from "./csrf";

export const SESSION_COOKIE = "acme_session";
export const CART_COOKIE = "acme_cart";
/** Cookie of the removed simulated mailbox; still expired on logout for older browsers. */
export const LEGACY_MAIL_COOKIE = "acme_mail";
/** Header sent by background polling so it does not extend the idle timeout. */
export const PASSIVE_HEADER = "x-acme-passive";
/** Custom header required on multipart uploads (forces a CORS preflight for cross-origin callers). */
export const UPLOAD_HEADER = "x-requested-with";

/** Maximum request body per route type, enforced before parsing. */
export const LIMITS = {
  json: 16 * 1024,
  upload: 2_500_000,
  webhook: 64 * 1024,
  cspReport: 8 * 1024,
} as const;

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function requestIp(request: Request): string {
  return clientIp(request.headers);
}

export async function readSession(request: Request): Promise<PublicUser | null> {
  const touch = request.headers.get(PASSIVE_HEADER) !== "1";
  return sessionUser(readCookie(request, SESSION_COOKIE), { touch, ip: requestIp(request) });
}

function deny(request: Request, actor: PublicUser | null, status: 401 | 403, detail: string, code = status === 401 ? "unauthorized" : "forbidden"): never {
  const url = new URL(request.url);
  securityLog({ type: "authz.denied", outcome: "blocked", actorId: actor?.id ?? null, ip: requestIp(request), method: request.method, path: url.pathname, status, detail });
  if (status === 401) throw new AppError("Sign in to continue.", 401, code);
  if (code === "password_change_required") throw new AppError("Change your password to continue.", 403, code);
  if (code === "step_up_required") throw new AppError("Confirm it is you to continue.", 403, code);
  if (code === "mfa_enrollment_required") throw new AppError("Set up two-step verification in Settings to continue.", 403, code);
  throw new AppError("You do not have access to this area.", 403, code);
}

/**
 * Central route authorization. Runs before any handler: public routes pass, every other route
 * needs a session, an activated password and the permission the route declares in API_ROUTES.
 */
export async function authorizeRoute(request: Request, route: ApiRoute): Promise<PublicUser | null> {
  if (route.access === "public") {
    return route.optionalUser ? readSession(request) : null;
  }
  const actor = await readSession(request);
  if (!actor) deny(request, null, 401, `${route.method} ${route.path} requires a session`);
  // User-level tier: one account cannot exceed its budget, whatever IP addresses it uses.
  const tier = route.method === "GET" ? "read" : "write";
  if (!rateLimit(`user-${tier}:${actor.id}`, USER_LIMITS[tier], WINDOW_MS)) rateLimited(request, `user-${tier}`, "per account");
  if (actor.mustChangePassword && !route.allowDuringPasswordChange) {
    deny(request, actor, 403, "password change required", "password_change_required");
  }
  if (!allows(route.access, actor)) deny(request, actor, 403, `${route.method} ${route.path} requires ${route.access}`);
  if (stepUpRequired(route, actor)) {
    // Critical request (T338): needs a recent additional authentication in this session.
    const status = await stepUpStatus(readCookie(request, SESSION_COOKIE));
    if (!status?.fresh) {
      const enroll = requiresSecondFactor(actor.role) && !status?.mfaEnabled;
      deny(request, actor, 403, `${route.method} ${route.path} requires additional authentication`, enroll ? "mfa_enrollment_required" : "step_up_required");
    }
  }
  if (route.access !== "user") {
    const url = new URL(request.url);
    securityLog({ type: "authz.granted", outcome: "success", actorId: actor.id, ip: requestIp(request), method: request.method, path: url.pathname, detail: route.access });
  }
  return actor;
}

/** Defense in depth inside handlers: the actor must exist (and hold a permission when given). */
export function requireActor(actor: PublicUser | null, permission?: Permission): PublicUser {
  if (!actor) throw new AppError("Sign in to continue.", 401, "unauthorized");
  if (permission && !can(actor.role, permission)) throw new AppError("You do not have access to this area.", 403, "forbidden");
  return actor;
}

export function cartId(request: Request): string {
  const existing = readCookie(request, CART_COOKIE);
  if (existing && /^[a-f0-9]{32}$/.test(existing)) return existing;
  return randomToken(16);
}

const COOKIE_DEFAULTS = { httpOnly: true, sameSite: "lax" as const, secure: true, path: "/" };

export function setSessionCookie(response: NextResponse, token: string) {
  response.cookies.set(SESSION_COOKIE, token, { ...COOKIE_DEFAULTS, maxAge: securityConfig().sessionMaxAgeMinutes * 60 });
}

export function clearSessionCookie(response: NextResponse) {
  response.cookies.set(SESSION_COOKIE, "", { ...COOKIE_DEFAULTS, maxAge: 0 });
}

/** Logout: expire every app cookie and ask the browser to drop cached data, cookies and storage. */
export function clearClientState(response: NextResponse) {
  response.headers.set("Clear-Site-Data", '"cache", "cookies", "storage"');
  for (const name of [SESSION_COOKIE, CART_COOKIE, LEGACY_MAIL_COOKIE, CSRF_COOKIE]) {
    response.cookies.set(name, "", { ...COOKIE_DEFAULTS, maxAge: 0 });
  }
}

export interface CsrfIssue {
  token: string;
  secret: string;
  fresh: boolean;
}

/**
 * Issues an anti-CSRF token for this browser (see src/lib/csrf.ts). The secret cookie is reused
 * when valid; `rotate` replaces it (sign-in), so earlier tokens stop working.
 */
export function prepareCsrf(request: Request, rotate = false): CsrfIssue {
  const existing = rotate ? undefined : readCookie(request, CSRF_COOKIE);
  const secret = isCsrfSecret(existing) ? existing : createCsrfSecret();
  return { token: createCsrfToken(secret), secret, fresh: secret !== existing };
}

export function applyCsrfCookie(response: NextResponse, issue: CsrfIssue) {
  if (!issue.fresh) return;
  response.cookies.set(CSRF_COOKIE, issue.secret, { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: securityConfig().sessionMaxAgeMinutes * 60 });
}

export async function ensureCartCookie(response: NextResponse, id: string) {
  response.cookies.set(CART_COOKIE, id, { ...COOKIE_DEFAULTS, maxAge: 60 * 60 * 24 * 30 });
}

function rateLimited(request: Request, bucket: string, detail: string): never {
  securityLog({ type: "rate_limit.exceeded", outcome: "blocked", ip: requestIp(request), method: request.method, path: new URL(request.url).pathname, status: 429, detail: `${bucket}: ${detail}` });
  throw new AppError("Too many requests. Please wait and try again.", 429, "rate_limited");
}

const WINDOW_MS = 15 * 60_000;

/** Throttles a request per client IP (and per account when one is known) in a 15-minute window. */
export function throttle(request: Request, bucket: string, limit: number, accountKey?: string | null) {
  if (!rateLimit(`${bucket}:ip:${requestIp(request)}`, limit, WINDOW_MS)) rateLimited(request, bucket, "per IP");
  if (accountKey && !rateLimit(`${bucket}:acct:${accountKey}`, limit, WINDOW_MS)) rateLimited(request, bucket, "per account");
}

/**
 * Shared throttle for authentication endpoints (brute-force targets): the counters live in the data
 * store, so they hold across server instances and restarts (see sharedRateLimit). Limits apply per
 * client IP and per account in a 15-minute window.
 */
export async function sharedThrottle(request: Request, bucket: string, limit: number, accountKey?: string | null) {
  const keys = [{ key: `${bucket}:ip:${requestIp(request)}`, scope: "per IP" }];
  if (accountKey) keys.push({ key: `${bucket}:acct:${accountKey.toLowerCase()}`, scope: "per account" });
  const blocked = await updateStore((data) => {
    for (const item of keys) {
      const result = sharedRateLimit(data.throttle, item.key, limit, WINDOW_MS);
      data.throttle = result.counters;
      if (!result.allowed) return item.scope;
    }
    return null;
  });
  if (blocked) rateLimited(request, bucket, `${blocked}, shared`);
}

/** Per-account request budgets for every authenticated route (user-level throttling tier). */
export const USER_LIMITS = { read: 1500, write: 150 } as const;

function mediaType(request: Request): string {
  return (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
}

/**
 * Guard for every state-changing request: same-origin check (Fetch Metadata and Origin), a
 * request shape an HTML form cannot produce (JSON, or the custom upload header), a valid
 * anti-CSRF token in the X-CSRF-Token header (verified against the secret cookie) and throttling.
 */
export function guardMutation(request: Request, bucket: string, limit = 30, options: { upload?: boolean; accountKey?: string | null } = {}) {
  try {
    assertSameOrigin(request);
    if (options.upload) {
      if (request.headers.get(UPLOAD_HEADER) !== "fetch" || mediaType(request) !== "multipart/form-data") {
        throw new AppError("Unsupported upload request.", 415, "unsupported_media_type");
      }
    } else if (mediaType(request) !== "application/json") {
      throw new AppError("Send the request as JSON.", 415, "unsupported_media_type");
    }
    if (!verifyCsrfToken(readCookie(request, CSRF_COOKIE), request.headers.get(CSRF_HEADER))) {
      throw new AppError("This page has expired. Reload it and try again.", 403, "csrf_invalid");
    }
  } catch (error) {
    if (error instanceof AppError) {
      securityLog({ type: "csrf.blocked", outcome: "blocked", ip: requestIp(request), method: request.method, path: new URL(request.url).pathname, status: error.status, detail: error.message });
    }
    throw error;
  }
  throttle(request, bucket, limit, options.accountKey);
}

function tooLarge(): AppError {
  return new AppError("The request is too large.", 413, "payload_too_large");
}

/** Reads at most `limit` bytes of the body; larger bodies are rejected without being buffered. */
export async function readBodyBytes(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw tooLarge();
  if (!request.body) return new Uint8Array(new ArrayBuffer(0));
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Decodes the body as strict UTF-8; malformed or overlong sequences are refused. */
export async function readBodyText(request: Request, limit: number): Promise<string> {
  const bytes = await readBodyBytes(request, limit);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new AppError("The request is not valid UTF-8.", 400, "bad_encoding");
  }
}

function assertPrintable(value: unknown) {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  while (stack.length) {
    const current = stack.pop()!;
    if (current.depth > 8) throw new AppError("The request is nested too deeply.", 400, "bad_request");
    if (typeof current.value === "string") {
      if (CONTROL_CHARS.test(current.value)) throw new AppError("Remove control characters from the form.", 400, "bad_request");
    } else if (Array.isArray(current.value)) {
      if (current.value.length > 100) throw new AppError("The request has too many items.", 400, "bad_request");
      for (const item of current.value) stack.push({ value: item, depth: current.depth + 1 });
    } else if (current.value && typeof current.value === "object") {
      for (const [key, item] of Object.entries(current.value)) {
        if (key.length > 60 || CONTROL_CHARS.test(key)) throw new AppError("The request has an invalid field name.", 400, "bad_request");
        stack.push({ value: item, depth: current.depth + 1 });
      }
    }
  }
}

/** Reads a size-limited JSON body (empty bodies become {}), refusing control characters. */
export async function readJson(request: Request, limit: number = LIMITS.json): Promise<unknown> {
  const text = await readBodyText(request, limit);
  if (!text.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new AppError("The request body is not valid JSON.", 400, "bad_request");
  }
  assertPrintable(value);
  return value;
}

/** Parses a multipart body only after it is known to fit within the limit. */
export async function readForm(request: Request, limit: number = LIMITS.upload): Promise<FormData> {
  const bytes = await readBodyBytes(request, limit);
  const contentType = request.headers.get("content-type") ?? "";
  try {
    return await new Response(bytes, { headers: { "content-type": contentType } }).formData();
  } catch {
    throw new AppError("The upload could not be read.", 400, "bad_request");
  }
}

/** Rejects control characters and oversized values in the path and query string. */
export function assertSafeUrl(request: Request, parts: string[]) {
  for (const part of parts) {
    if (part.length > 120 || CONTROL_CHARS.test(part)) throw new AppError("Invalid request path.", 400, "bad_request");
  }
  const url = new URL(request.url);
  let count = 0;
  for (const [key, value] of url.searchParams) {
    count += 1;
    if (count > 20 || key.length > 40 || value.length > 200 || CONTROL_CHARS.test(key) || CONTROL_CHARS.test(value)) {
      throw new AppError("Invalid query string.", 400, "bad_request");
    }
  }
}

/**
 * Origin used to build absolute URLs sent to third parties (Stripe return URLs). It comes from
 * APP_ORIGIN; the request's own origin is accepted only outside production.
 */
export function trustedOrigin(request: Request): string {
  const config = securityConfig();
  if (config.appOrigin) return config.appOrigin;
  if (!config.production) return new URL(request.url).origin;
  throw new AppError("Online checkout is not configured.", 503, "unavailable");
}

export function jsonError(error: unknown, request?: Request) {
  const url = request ? new URL(request.url) : null;
  const mapped = toErrorResponse(error, { method: request?.method, path: url?.pathname });
  // Throttled clients are told when the 15-minute window allows them again.
  const headers = mapped.status === 429 ? { "Retry-After": String(WINDOW_MS / 1000) } : undefined;
  return NextResponse.json(mapped.body, { status: mapped.status, headers });
}
