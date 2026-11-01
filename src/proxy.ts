import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { sessionUser } from "./services/auth";
import { allows, pageAccess } from "./lib/policy";
import { buildPageCsp, NO_STORE_HEADERS, REPORTING_ENDPOINTS } from "./lib/security-headers";
import { clientIp } from "./lib/security";
import { securityLog } from "./lib/security-log";
import { securityConfig } from "./lib/config";

const SESSION_COOKIE = "acme_session";

function denied(request: NextRequest, status: number, actorId: string | null, detail: string) {
  securityLog({
    type: "page.denied",
    outcome: "blocked",
    actorId,
    ip: clientIp(request.headers),
    method: request.method,
    path: request.nextUrl.pathname,
    status,
    detail,
  });
}

function withNoStore(response: NextResponse) {
  for (const header of NO_STORE_HEADERS) response.headers.set(header.key, header.value);
  return response;
}

/**
 * Runs before every page: sends plain-HTTP requests to the canonical HTTPS origin (APP_ORIGIN), authorizes non-public pages on the server
 * (see PUBLIC_PAGES and PROTECTED_PAGES in src/lib/policy.ts) and sets a nonce-based CSP.
 */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const appOrigin = securityConfig().appOrigin;
  if (appOrigin?.startsWith("https:") && forwardedProto === "http") {
    return NextResponse.redirect(new URL(`${pathname}${search}`, appOrigin), 308);
  }

  const access = pageAccess(pathname);
  if (access !== "public") {
    const token = request.cookies.get(SESSION_COOKIE)?.value;
    const user = token ? await sessionUser(token, { touch: false }) : null;
    if (!user) {
      denied(request, 401, null, `${access} page without a session`);
      const login = new URL("/login", request.url);
      login.searchParams.set("next", `${pathname}${search}`);
      return withNoStore(NextResponse.redirect(login, 307));
    }
    if (user.mustChangePassword && pathname !== "/account/settings") {
      denied(request, 403, user.id, "password change required");
      return withNoStore(NextResponse.redirect(new URL("/account/settings?required=1", request.url), 307));
    }
    if (!allows(access, user)) {
      denied(request, 403, user.id, `page requires ${access}`);
      return withNoStore(
        new NextResponse("You do not have access to this page.", {
          status: 403,
          headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'" },
        }),
      );
    }
  }

  const nonce = randomBytes(16).toString("base64");
  const https = request.nextUrl.protocol === "https:" || forwardedProto === "https";
  const csp = buildPageCsp(nonce, { development: process.env.NODE_ENV === "development", https });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("Reporting-Endpoints", REPORTING_ENDPOINTS);
  return access === "public" ? response : withNoStore(response);
}

export const config = {
  matcher: ["/((?!api/|_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml)$).*)"],
};
