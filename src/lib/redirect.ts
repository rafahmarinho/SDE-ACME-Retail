import { isKnownPage } from "./policy";

const BASE = "https://acme-retail.invalid";

/**
 * Validates a post-login redirect target. Only internal paths of known pages are accepted;
 * absolute URLs, protocol-relative URLs ("//host"), backslash tricks and control characters fall
 * back to the default destination, so ?next= cannot send users to another site.
 */
export function safeNextPath(value: string | null | undefined, fallback: string): string {
  if (!value || value.length > 300) return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001F\u007F]/.test(value)) return fallback;
  let url: URL;
  try {
    url = new URL(value, BASE);
  } catch {
    return fallback;
  }
  if (url.origin !== BASE || !isKnownPage(url.pathname)) return fallback;
  return `${url.pathname}${url.search}`;
}
