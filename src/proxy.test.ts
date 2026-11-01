import assert from "node:assert/strict";
import test, { before } from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";
import { changePassword, login } from "./services/auth";
import { resetStore } from "./lib/db/store";
import { PROTECTED_PAGES, PUBLIC_PAGES } from "./lib/policy";
import { captureLogs, testPassword } from "./test/support";

process.env.ACME_DATA_PATH = "memory";
const SEED_PASSWORD = testPassword();
process.env.ACME_SEED_PASSWORD = SEED_PASSWORD;
const logs = captureLogs();
const tokens: Record<string, string> = {};

async function activated(email: string, name: string) {
  const first = await login(email, SEED_PASSWORD);
  const next = testPassword({ email, name });
  await changePassword(first.user.id, SEED_PASSWORD, next);
  return (await login(email, next)).token;
}

before(async () => {
  await resetStore();
  tokens.catalog = await activated("catalog@acme-retail.test", "Morgan Blake");
  tokens.finance = await activated("finance@acme-retail.test", "Quinn Adeyemi");
  tokens.customer = await activated("customer@acme-retail.test", "Avery Chen");
  tokens.initial = (await login("warehouse@acme-retail.test", SEED_PASSWORD)).token;
});

function page(path: string, token?: string, headers: Record<string, string> = {}) {
  return proxy(new NextRequest(`http://localhost${path}`, { headers: { ...(token ? { cookie: `acme_session=${token}` } : {}), ...headers } }));
}

function concrete(path: string) {
  return path.replace(":id", "ord_001").replace(":slug", "merino-crew-tee");
}

test("every non-public page redirects anonymous visitors to sign-in", async () => {
  for (const item of PROTECTED_PAGES) {
    const response = await page(concrete(item.path));
    assert.equal(response.status, 307, item.path);
    const location = new URL(response.headers.get("location")!);
    assert.equal(location.pathname, "/login");
    assert.equal(location.searchParams.get("next"), concrete(item.path));
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  }
  const unknown = await page("/admin-console");
  assert.equal(unknown.status, 307, "pages that are not white-listed require a session");
  assert.ok(logs.some((entry) => entry.type === "page.denied" && entry.status === 401));
});

test("a stale or forged session cookie is treated as anonymous", async () => {
  const response = await page("/account", "f".repeat(64));
  assert.equal(response.status, 307);
});

test("role-restricted pages answer 403 to signed-in users without the permission", async () => {
  const blocked = await page("/office/refunds", tokens.catalog);
  assert.equal(blocked.status, 403);
  assert.equal((await page("/office/orders", tokens.catalog)).status, 403, "catalog cannot open orders");
  assert.equal((await page("/office/products", tokens.finance)).status, 403);
  assert.equal((await page("/checkout", tokens.finance)).status, 403, "staff cannot open checkout");
  assert.equal((await page("/office/refunds", tokens.finance)).status, 200);
  assert.equal((await page("/office/products", tokens.catalog)).status, 200);
  assert.equal((await page("/account/orders/ord_001", tokens.customer)).status, 200);
  assert.equal((await page("/office", tokens.customer)).status, 403, "customers have no back office");
});

test("accounts that still use the initial password are sent to change it", async () => {
  const response = await page("/office/inventory", tokens.initial);
  assert.equal(response.status, 307);
  assert.equal(new URL(response.headers.get("location")!).pathname, "/account/settings");
  assert.equal((await page("/account/settings", tokens.initial)).status, 200);
});

test("public pages carry a nonce-based CSP without unsafe-inline, unique per request", async () => {
  const nonces = new Set<string>();
  for (const path of PUBLIC_PAGES) {
    const response = await page(concrete(path));
    assert.equal(response.status, 200, path);
    const csp = response.headers.get("content-security-policy") ?? "";
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    assert.ok(nonce, `${path} has a nonce`);
    nonces.add(nonce!);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    for (const directive of ["default-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "report-uri /api/csp-report", "form-action 'self'"]) {
      assert.ok(csp.includes(directive), `${path} lacks ${directive}`);
    }
    assert.equal(response.headers.get("x-middleware-request-x-nonce"), nonce, "Next.js receives the nonce to apply to its scripts");
  }
  assert.equal(nonces.size, PUBLIC_PAGES.length);
});

test("protected pages are not cacheable", async () => {
  const response = await page("/account", tokens.customer);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store, no-cache, must-revalidate, private, max-age=0");
  assert.equal(response.headers.get("pragma"), "no-cache");
});

test("plain HTTP is redirected to the canonical HTTPS origin and HTTPS pages upgrade insecure requests", async () => {
  process.env.APP_ORIGIN = "https://shop.example";
  try {
    const redirect = await page("/catalog?q=mug", undefined, { "x-forwarded-proto": "http" });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get("location"), "https://shop.example/catalog?q=mug");
    const secure = await page("/catalog", undefined, { "x-forwarded-proto": "https" });
    assert.ok(secure.headers.get("content-security-policy")?.includes("upgrade-insecure-requests"));
  } finally {
    delete process.env.APP_ORIGIN;
  }
});
