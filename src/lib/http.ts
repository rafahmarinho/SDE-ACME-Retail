import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { AppError, toErrorResponse } from "./errors";
import { assertSameOrigin, clientIp, randomToken, rateLimit } from "./security";
import { sessionUser } from "../services/auth";
import type { PublicUser } from "./types";
import { can } from "../services/retail";

export const SESSION_COOKIE = "acme_session";
export const CART_COOKIE = "acme_cart";
export const MAIL_COOKIE = "acme_mail";

export async function readSession(): Promise<PublicUser | null> {
  const jar = await cookies();
  return sessionUser(jar.get(SESSION_COOKIE)?.value);
}

export async function requireUser(): Promise<PublicUser> {
  const user = await readSession();
  if (!user) throw new AppError("Sign in to continue.", 401, "unauthorized");
  return user;
}

export async function requireArea(area: "products" | "inventory" | "orders" | "refunds" | "scenarios") {
  const user = await requireUser();
  if (!can(user.role, area)) throw new AppError("You do not have access to this area.", 403, "forbidden");
  return user;
}

export async function cartId(): Promise<string> {
  const jar = await cookies();
  const existing = jar.get(CART_COOKIE)?.value;
  if (existing && /^[a-f0-9]{32}$/.test(existing)) return existing;
  return randomToken(16);
}

export function setSessionCookie(response: NextResponse, token: string) {
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 12,
  });
}

export function clearSessionCookie(response: NextResponse) {
  response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
}

export async function ensureCartCookie(response: NextResponse, id: string) {
  response.cookies.set(CART_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function mailKey(): Promise<string> {
  const jar = await cookies();
  return jar.get(MAIL_COOKIE)?.value ?? "";
}

export function guardMutation(request: Request, bucket: string, limit = 30) {
  assertSameOrigin(request);
  if (!rateLimit(`${bucket}:${clientIp(request.headers)}`, limit, 15 * 60_000)) {
    throw new AppError("Too many requests. Please wait and try again.", 429, "rate_limited");
  }
}

export function jsonError(error: unknown) {
  const mapped = toErrorResponse(error);
  return NextResponse.json(mapped.body, { status: mapped.status });
}
