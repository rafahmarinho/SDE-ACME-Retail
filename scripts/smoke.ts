/**
 * HTTP smoke test against a running server (next start). Usage:
 *   BASE_URL=http://localhost:3000 pnpm test:smoke
 * CI runs it after `pnpm build` to check the headers and guards of the real Next.js server.
 */
import assert from "node:assert/strict";
import test from "node:test";

const base = process.env.BASE_URL;
if (!base) throw new Error("Set BASE_URL to the running server, for example http://localhost:3000");

function get(path: string, init: RequestInit = {}) {
  return fetch(new URL(path, base), { redirect: "manual", ...init });
}

test("pages send HSTS, the security headers and a nonce-based CSP applied to every script", async () => {
  const response = await get("/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("strict-transport-security") ?? "", /max-age=31536000; includeSubDomains/);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.ok(response.headers.get("permissions-policy"));
  assert.equal(response.headers.get("x-powered-by"), null);
  const csp = response.headers.get("content-security-policy") ?? "";
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  for (const directive of ["default-src 'self'", "frame-ancestors 'none'", "form-action 'self'", "connect-src 'self'", "report-uri /api/csp-report"]) {
    assert.ok(csp.includes(directive), directive);
  }
  const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
  assert.ok(nonce);
  const html = await response.text();
  const scripts = html.match(/<script\b[^>]*>/g) ?? [];
  assert.ok(scripts.length > 0);
  for (const tag of scripts) assert.ok(tag.includes(`nonce="${nonce}"`), `script without nonce: ${tag}`);
  assert.doesNotMatch(html, /\sstyle="/, "no inline style attributes in server-rendered HTML");
});

test("confidential pages are not cached and protected pages require a session", async () => {
  for (const path of ["/login", "/recover", "/reset", "/cart"]) {
    const response = await get(path);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/, path);
    assert.equal(response.headers.get("pragma"), "no-cache", path);
  }
  const office = await get("/office/refunds");
  assert.equal(office.status, 307);
  assert.equal(office.headers.get("location"), "/login?next=%2Foffice%2Frefunds");
});

test("API responses are locked down and mutations need a same-origin JSON request", async () => {
  const session = await get("/api/session");
  assert.equal(session.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  assert.match(session.headers.get("cache-control") ?? "", /no-store/);
  const forged = await get("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(forged.status, 403);
  assert.equal((await get("/api/mail")).status, 404);
  const report = await get("/api/csp-report", {
    method: "POST",
    headers: { "content-type": "application/csp-report" },
    body: JSON.stringify({ "csp-report": { "document-uri": base, "blocked-uri": "inline", "violated-directive": "script-src-elem" } }),
  });
  assert.equal(report.status, 204);
});

test("release build: client bundles publish no source maps and pages get an anti-CSRF token", async () => {
  const html = await (await get("/")).text();
  const script = /<script[^>]+src="([^"]+\.js)"/.exec(html)?.[1];
  assert.ok(script, "the page loads a script bundle");
  const bundle = await (await get(script)).text();
  assert.doesNotMatch(bundle, /sourceMappingURL=/);
  assert.equal((await get(`${script}.map`)).status, 404);
  const session = await get("/api/session");
  const body = (await session.json()) as { csrfToken?: string };
  assert.match(body.csrfToken ?? "", /^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/);
  const cookie = session.headers.getSetCookie().find((item) => item.startsWith("__Host-acme_csrf="));
  assert.ok(cookie && /HttpOnly/i.test(cookie) && /Secure/i.test(cookie) && /SameSite=strict/i.test(cookie));
});
