import { randomBytes } from "node:crypto";
import { passwordIssues } from "../lib/security";
import { setLogSink, type LogEntry } from "../lib/security-log";
import { leadingZeroBits, powDigest } from "../lib/pow";

/**
 * Solves an anti-automation challenge the way the browser does (src/app/recover/page.tsx). It yields
 * to the event loop between batches, as a browser tab would, so the server under test stays responsive.
 */
export async function solvePow(salt: string, difficulty: number): Promise<string> {
  if (typeof salt !== "string" || !Number.isInteger(difficulty) || difficulty < 1 || difficulty > 24) throw new Error("Invalid challenge.");
  for (let nonce = 0; ; nonce += 1) {
    if (nonce % 2000 === 0) await new Promise((resolve) => setImmediate(resolve));
    if (leadingZeroBits(powDigest(salt, String(nonce))) >= difficulty) return String(nonce);
  }
}

/** Random password that satisfies the policy, generated per test run (nothing is hard-coded). */
export function testPassword(context: { email?: string; name?: string } = {}): string {
  for (;;) {
    const candidate = `Tz-${randomBytes(9).toString("base64url")}-q7!`;
    if (passwordIssues(candidate, context).length === 0) return candidate;
  }
}

/** Captures security and application log entries instead of printing them. */
export function captureLogs(): LogEntry[] {
  const entries: LogEntry[] = [];
  setLogSink((entry) => {
    entries.push(entry);
  });
  return entries;
}

export interface CallOptions {
  body?: unknown;
  rawBody?: BodyInit;
  cookie?: string;
  headers?: Record<string, string>;
  origin?: string | null;
  ip?: string;
  contentType?: string | null;
}

export interface CallResult {
  status: number;
  body: unknown;
  text: string;
  headers: Headers;
  setCookies: string[];
}

type Handler = (request: Request, context: { params: Promise<{ path?: string[] }> }) => Promise<Response>;

/** Sends a request straight to the catch-all API route handler, the way Next.js would. */
export async function callRoute(handlers: Record<string, Handler>, method: string, path: string, options: CallOptions = {}): Promise<CallResult> {
  // Real requests arrive through network I/O; yield to the event loop like a socket read would.
  await new Promise((resolve) => setImmediate(resolve));
  const url = new URL(path, "http://localhost");
  const headers = new Headers({ host: "localhost", "x-forwarded-for": options.ip ?? "203.0.113.10" });
  if (options.origin !== null) headers.set("origin", options.origin ?? "http://localhost");
  if (options.cookie) headers.set("cookie", options.cookie);
  let body: BodyInit | undefined;
  if (method === "GET" || method === "HEAD") body = undefined;
  else if (options.rawBody !== undefined) body = options.rawBody;
  else if (options.body !== undefined) body = JSON.stringify(options.body);
  const contentType = options.contentType === undefined ? (method === "GET" ? null : "application/json") : options.contentType;
  if (contentType) headers.set("content-type", contentType);
  for (const [key, value] of Object.entries(options.headers ?? {})) headers.set(key, value);
  const init: RequestInit & { duplex?: "half" } = { method, headers, body };
  if (body instanceof ReadableStream) init.duplex = "half";
  const request = new Request(url, init);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const handler = handlers[method];
  if (!handler) throw new Error(`No ${method} handler`);
  const response = await handler(request, { params: Promise.resolve({ path: parts }) });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed, text, headers: response.headers, setCookies: response.headers.getSetCookie() };
}

/** Builds a Cookie header value from Set-Cookie headers (name=value pairs only). */
export function cookieHeader(setCookies: string[]): string {
  return setCookies
    .map((item) => item.split(";")[0])
    .filter((pair) => !pair.endsWith("="))
    .join("; ");
}

/** Keys that must never appear in any API response. */
export const SECRET_KEYS = ["passwordHash", "passwordHistory", "tokenHash", "resetTokens", "sessions", "failedLogins", "lockedUntil", "lastFailedAt", "lockouts", "sessionKey", "mfa", "mfaPending", "recoveryCodeHashes", "lastCounter", "stepUpAt"];

export function findKeys(value: unknown, keys: string[], found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) findKeys(item, keys, found);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (keys.includes(key)) found.add(key);
      findKeys(item, keys, found);
    }
  }
  return found;
}
