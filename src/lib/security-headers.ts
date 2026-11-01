/**
 * HTTP security headers shared by next.config.ts (static headers) and src/proxy.ts (per-request
 * Content-Security-Policy with a nonce). Keeping them in one module lets tests assert the exact
 * values that are deployed.
 */
export const HSTS_VALUE = "max-age=31536000; includeSubDomains";

export const BASE_SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "Strict-Transport-Security", value: HSTS_VALUE },
];

/** Confidential responses must not be stored by browsers or shared caches (HTTP/1.1 and 1.0). */
export const NO_STORE_HEADERS = [
  { key: "Cache-Control", value: "no-store, no-cache, must-revalidate, private, max-age=0" },
  { key: "Pragma", value: "no-cache" },
  { key: "Expires", value: "0" },
];

/** Pages that show account, order or credential data. */
export const CONFIDENTIAL_PAGE_SOURCES = [
  "/account",
  "/account/:path*",
  "/office",
  "/office/:path*",
  "/checkout",
  "/cart",
  "/wishlist",
  "/payment/:path*",
  "/login",
  "/recover",
  "/reset",
];

/** API responses are data, never documents: nothing may load or frame them. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export const CSP_REPORT_PATH = "/api/csp-report";
export const REPORTING_ENDPOINTS = `csp="${CSP_REPORT_PATH}"`;

/**
 * Page policy: scripts and styles run only with the per-request nonce (no 'unsafe-inline' or
 * 'unsafe-eval' in production), violations are reported to CSP_REPORT_PATH.
 */
export function buildPageCsp(nonce: string, options: { development: boolean; https: boolean }): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${options.development ? " 'unsafe-eval'" : ""}`,
    options.development ? "style-src 'self' 'unsafe-inline'" : `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://checkout.stripe.com",
    "frame-ancestors 'none'",
    `report-uri ${CSP_REPORT_PATH}`,
    "report-to csp",
    ...(options.https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}
