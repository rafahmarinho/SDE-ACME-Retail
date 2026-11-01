import assert from "node:assert/strict";
import test, { before } from "node:test";
import * as route from "./[[...path]]/route";
import { resetStore, readStore, updateStore } from "../../lib/db/store";
import { orderFeedPlan } from "../../lib/db/supabase-state";
import { sha256 } from "../../lib/security";
import { totpCode } from "../../lib/totp";
import { clearDevOutbox, devOutbox, MAIL_FOOTER } from "../../lib/mailer";
import { API_ROUTES, can, matchApiRoute, type Permission } from "../../lib/policy";
import { trustedOrigin, USER_LIMITS } from "../../lib/http";
import { resetRateLimits } from "../../lib/security";
import { AppError } from "../../lib/errors";
import type { Role } from "../../lib/types";
import { PRIVACY_NOTICE_VERSION } from "../../lib/privacy";
import { callRoute, captureLogs, findKeys, SECRET_KEYS, solvePow, testPassword, type CallOptions, type CallResult } from "../../test/support";

process.env.ACME_DATA_PATH = "memory";
const SEED_PASSWORD = testPassword();
process.env.ACME_SEED_PASSWORD = SEED_PASSWORD;
const logs = captureLogs();
const handlers = { GET: route.GET, POST: route.POST, PATCH: route.PATCH, PUT: route.PUT, DELETE: route.DELETE };
const bodies: unknown[] = [];

const CSRF_COOKIE = "__Host-acme_csrf";

interface ClientCallOptions extends CallOptions {
  /** Send the page's anti-CSRF token with state-changing requests (default true). */
  csrf?: boolean;
}

/** A browser: cookie jar plus the in-memory anti-CSRF token a page gets from GET /api/session. */
class Client {
  jar = new Map<string, string>();
  csrf: string | null = null;
  constructor(readonly ip: string) {}

  get cookie() {
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  async call(method: string, path: string, options: ClientCallOptions = {}): Promise<CallResult> {
    const { csrf: sendCsrf = true, ...rest } = options;
    const mutation = method !== "GET" && method !== "HEAD";
    if (mutation && sendCsrf && !this.csrf) await this.call("GET", "/api/session");
    const headers = { ...(mutation && sendCsrf && this.csrf ? { "x-csrf-token": this.csrf } : {}), ...rest.headers };
    const result = await callRoute(handlers, method, path, { ip: this.ip, cookie: this.cookie || undefined, ...rest, headers });
    for (const raw of result.setCookies) {
      const [pair, ...attributes] = raw.split(";");
      const index = pair.indexOf("=");
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (!value || attributes.some((item) => /max-age=0/i.test(item.trim()))) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    const token = (result.body as { csrfToken?: unknown } | null)?.csrfToken;
    if (typeof token === "string") this.csrf = token;
    if (!this.jar.has(CSRF_COOKIE)) this.csrf = null;
    bodies.push(result.body);
    return result;
  }
}

const ACCOUNTS: Record<string, { email: string; name: string; role: Role }> = {
  customer: { email: "customer@acme-retail.test", name: "Avery Chen", role: "customer" },
  catalog: { email: "catalog@acme-retail.test", name: "Morgan Blake", role: "catalog" },
  warehouse: { email: "warehouse@acme-retail.test", name: "Riley Ortiz", role: "warehouse" },
  finance: { email: "finance@acme-retail.test", name: "Quinn Adeyemi", role: "finance" },
  administrator: { email: "admin@acme-retail.test", name: "Jordan Hale", role: "administrator" },
  jordan: { email: "jordan.lee@acme-retail.test", name: "Jordan Lee", role: "customer" },
};

const clients: Record<string, Client> = {};
const passwords: Record<string, string> = {};
const mfaSecrets: Record<string, string> = {};
let ipCounter = 20;

function freshIp() {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

async function activate(key: string) {
  const account = ACCOUNTS[key];
  const client = new Client(freshIp());
  let result = await client.call("POST", "/api/auth/login", { body: { email: account.email, password: SEED_PASSWORD } });
  assert.equal(result.status, 200, `${key} initial login`);
  const next = testPassword({ email: account.email, name: account.name });
  result = await client.call("POST", "/api/account/password", { body: { current: SEED_PASSWORD, next } });
  assert.equal(result.status, 200, `${key} password change`);
  result = await client.call("POST", "/api/auth/login", { body: { email: account.email, password: next } });
  assert.equal(result.status, 200, `${key} login`);
  result = await client.call("POST", "/api/account/privacy", { body: { decision: "accept", noticeVersion: PRIVACY_NOTICE_VERSION, language: "en", consents: {} } });
  assert.equal(result.status, 200, `${key} privacy notice`);
  if (account.role === "customer") {
    // Customers confirm critical requests by re-entering their password.
    result = await client.call("POST", "/api/auth/step-up", { body: { password: next } });
    assert.equal(result.status, 200, `${key} step-up`);
  } else {
    // Staff enrol a second factor (TOTP); enabling it also confirms the current session.
    result = await client.call("POST", "/api/account/mfa/setup");
    assert.equal(result.status, 200, `${key} MFA setup`);
    mfaSecrets[key] = (result.body as { secret: string }).secret;
    result = await client.call("POST", "/api/account/mfa/enable", { body: { code: totpCode(mfaSecrets[key]) } });
    assert.equal(result.status, 200, `${key} MFA enable`);
  }
  passwords[key] = next;
  clients[key] = client;
}

before(async () => {
  await resetStore();
  for (const key of Object.keys(ACCOUNTS)) await activate(key);
});

function concretePath(path: string) {
  return `/api/${path.replace(":slug", "merino-crew-tee").replace(":id", "ord_001")}`;
}

async function placeOrder(client: Client, scenario = "approved") {
  const catalog = await client.call("GET", "/api/catalog?inStock=1");
  const variant = (catalog.body as { products: { variants: { id: string }[] }[] }).products[2].variants[0];
  assert.equal((await client.call("POST", "/api/cart", { body: { variantId: variant.id, qty: 1 } })).status, 200);
  const result = await client.call("POST", "/api/checkout", {
    body: {
      shippingMethod: "standard",
      scenario,
      address: { fullName: "Avery Chen", line1: "18 Market Street", city: "San Francisco", region: "CA", postalCode: "94105", country: "US" },
    },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return (result.body as { order: { id: string; totalCents: number; paymentStatus: string } }).order;
}

test("deny by default: undeclared routes and methods never reach a handler", async () => {
  const client = new Client(freshIp());
  assert.equal((await client.call("GET", "/api/mail")).status, 404, "simulated mailbox removed");
  assert.equal((await client.call("GET", "/api/office/orders/ord_001/secret")).status, 404);
  assert.equal((await client.call("PUT", "/api/orders")).status, 405);
  assert.equal((await client.call("DELETE", "/api/orders/ord_001")).status, 405);
  assert.ok(logs.some((entry) => entry.type === "route.unknown"));
  assert.ok(logs.some((entry) => entry.type === "method.unsupported"));
});

test("every non-public API route rejects anonymous callers with 401", async () => {
  const client = new Client(freshIp());
  for (const item of API_ROUTES.filter((entry) => entry.access !== "public")) {
    const result = await client.call(item.method, concretePath(item.path), { body: {} });
    assert.equal(result.status, 401, `${item.method} ${item.path}`);
  }
});

test("function-level authorization: each staff route answers 403 to every role without the permission", async () => {
  for (const item of API_ROUTES.filter((entry) => !["public", "user", "staff"].includes(entry.access))) {
    for (const key of ["customer", "catalog", "warehouse", "finance", "administrator"]) {
      const allowed = can(ACCOUNTS[key].role, item.access as Permission);
      const result = await clients[key].call(item.method, concretePath(item.path), { body: {} });
      if (allowed) assert.notEqual(result.status, 403, `${key} should reach ${item.method} ${item.path}`);
      else assert.equal(result.status, 403, `${key} must not reach ${item.method} ${item.path} (got ${result.status})`);
    }
  }
});

test("least privilege and data minimization on order data", async () => {
  assert.equal((await clients.catalog.call("GET", "/api/office/orders")).status, 403, "catalog cannot list orders");
  assert.equal((await clients.catalog.call("GET", "/api/orders/ord_001")).status, 404, "catalog cannot open an order");
  const list = await clients.finance.call("GET", "/api/office/orders?limit=100");
  assert.equal(list.status, 200);
  const page = list.body as { items: Record<string, unknown>[]; total: number };
  const rows = page.items;
  assert.equal(page.total, 60);
  assert.equal(rows.length, 60);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["carrier", "createdAt", "deliveryStatus", "id", "itemCount", "number", "paymentStatus", "totalCents", "trackingNumber", "updatedAt"]);
  const financeView = (await clients.finance.call("GET", "/api/orders/ord_001")).body as { order: Record<string, unknown>; refunds: unknown[] };
  assert.equal("address" in financeView.order, false, "finance does not need the shipping address");
  const warehouseView = (await clients.warehouse.call("GET", "/api/orders/ord_001")).body as { order: Record<string, unknown>; refunds: unknown[] };
  assert.equal("address" in warehouseView.order, true, "fulfilment needs the address");
  assert.deepEqual(warehouseView.refunds, [], "refunds are a finance concern");
  const session = (await clients.customer.call("GET", "/api/session")).body as { user: Record<string, unknown>; permissions: string[] };
  assert.deepEqual(session.permissions, ["orders.purchase"]);
  assert.deepEqual(Object.keys(session.user).sort(), ["email", "fullName", "id", "mfaEnabled", "mustChangePassword", "phone", "role"]);
});

test("result-set size: lists are paginated and filtered on the server and oversized pages are refused", async () => {
  type OrderPage = { items: { id: string; paymentStatus: string }[]; nextCursor: string | null; total: number };
  const finance = clients.finance;
  const tooBig = await finance.call("GET", "/api/office/orders?limit=101");
  assert.equal(tooBig.status, 400, "a page above the maximum is refused with an error");
  assert.deepEqual(tooBig.body, { error: "Check the form and try again.", code: "invalid_input" });
  assert.equal((await clients.customer.call("GET", "/api/orders?limit=51")).status, 400);
  assert.equal((await finance.call("GET", "/api/office/refunds?limit=1000")).status, 400);
  assert.equal((await new Client(freshIp()).call("GET", "/api/catalog?limit=500")).status, 400);
  assert.equal((await finance.call("GET", "/api/office/orders?cursor=-1")).status, 400);
  const first = (await finance.call("GET", "/api/office/orders?limit=25")).body as OrderPage;
  assert.equal(first.items.length, 25);
  assert.equal(first.nextCursor, "25");
  const second = (await finance.call("GET", `/api/office/orders?limit=25&cursor=${first.nextCursor}`)).body as OrderPage;
  assert.equal(second.items.length, 25);
  assert.ok(second.items.every((row) => !first.items.some((other) => other.id === row.id)), "pages do not overlap");
  const last = (await finance.call("GET", `/api/office/orders?limit=100&cursor=${first.total - 1}`)).body as OrderPage;
  assert.equal(last.items.length, 1);
  assert.equal(last.nextCursor, null, "the last page has no cursor");
  const defaults = (await finance.call("GET", "/api/office/orders")).body as OrderPage;
  assert.equal(defaults.items.length, 50, "without a limit the default page size applies");
  const declined = (await finance.call("GET", "/api/office/orders?payment=declined&limit=100")).body as OrderPage;
  assert.ok(declined.items.length > 0 && declined.items.every((row) => row.paymentStatus === "declined"), "filters run on the server");
  assert.equal((await finance.call("GET", "/api/office/orders?payment=bogus")).status, 400);
  const inventory = (await clients.warehouse.call("GET", "/api/office/inventory?q=AC-001")).body as { items: { sku: string }[] };
  assert.ok(inventory.items.length > 0 && inventory.items.every((row) => row.sku.startsWith("AC-001")));
});

test("object-level authorization: customers reach only their own orders", async () => {
  const mine = ((await clients.customer.call("GET", "/api/orders?limit=50")).body as { items: { id: string }[] }).items;
  const owners = await readStore((data) => mine.map((order) => data.orders.find((row) => row.id === order.id)?.userId));
  assert.ok(mine.length > 0 && owners.every((owner) => owner === "usr_01"));
  const others = ((await clients.jordan.call("GET", "/api/orders")).body as { items: { id: string }[] }).items;
  const foreign = others[0].id;
  assert.equal((await clients.customer.call("GET", `/api/orders/${foreign}`)).status, 404);
  assert.equal((await clients.customer.call("POST", `/api/orders/${foreign}/cancel`)).status, 404);
  assert.equal((await clients.customer.call("POST", `/api/orders/${foreign}/authenticate`)).status, 404);
});

test("separation of duties: only the buyer or finance can cancel, nobody else refunds", async () => {
  const first = await placeOrder(clients.customer);
  assert.equal((await clients.warehouse.call("POST", `/api/orders/${first.id}/cancel`)).status, 403);
  assert.equal((await clients.administrator.call("POST", `/api/orders/${first.id}/cancel`)).status, 403);
  assert.equal((await clients.catalog.call("POST", `/api/orders/${first.id}/cancel`)).status, 404);
  assert.equal((await clients.administrator.call("POST", "/api/office/refunds", { body: { orderId: first.id, amountCents: 100, reason: "Goodwill" } })).status, 403);
  assert.equal((await clients.finance.call("POST", "/api/office/refunds", { body: { orderId: first.id, amountCents: 100, reason: "Goodwill" } })).status, 200);
  const cancelled = await clients.finance.call("POST", `/api/orders/${first.id}/cancel`);
  assert.equal(cancelled.status, 200);
  const refunds = await readStore((data) => data.refunds.filter((item) => item.orderId === first.id));
  assert.equal(refunds.reduce((sum, item) => sum + item.amountCents, 0), first.totalCents, "cancellation refunds exactly the remaining amount");
  const second = await placeOrder(clients.customer);
  assert.equal((await clients.customer.call("POST", `/api/orders/${second.id}/cancel`)).status, 200, "buyers cancel their own orders");
  assert.equal((await clients.administrator.call("POST", "/api/checkout", { body: {} })).status, 403, "staff accounts cannot buy");
});

test("returns: only the buyer can open one, with a photo referenced by an opaque id they own", async () => {
  const orders = ((await clients.customer.call("GET", "/api/orders?limit=50")).body as { items: { id: string; deliveryStatus: string; items: { variantId: string }[] }[] }).items;
  const shipped = orders.filter((order) => ["shipped", "out_for_delivery", "delivered"].includes(order.deliveryStatus));
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const form = () => {
    const data = new FormData();
    data.set("file", new File([png], "photo.png", { type: "text/html" }));
    return data;
  };
  assert.equal((await clients.customer.call("POST", "/api/uploads", { rawBody: form(), contentType: null })).status, 415, "uploads need the custom header");
  const uploaded = await clients.customer.call("POST", "/api/uploads", { rawBody: form(), contentType: null, headers: { "x-requested-with": "fetch" } });
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
  const photoId = (uploaded.body as { id: string }).id;
  assert.match(photoId, /^[0-9a-f-]{36}$/);
  const stored = await readStore((data) => data.uploads.find((item) => item.id === photoId)!);
  assert.equal(stored.contentType, "image/png", "content type comes from the bytes, not the client");
  const mismatch = new FormData();
  mismatch.set("file", new File([png], "photo.jpg"));
  assert.equal((await clients.customer.call("POST", "/api/uploads", { rawBody: mismatch, contentType: null, headers: { "x-requested-with": "fetch" } })).status, 400);
  const jordanOrders = ((await clients.jordan.call("GET", "/api/orders?limit=50")).body as { items: { id: string; deliveryStatus: string; items: { variantId: string }[] }[] }).items;
  const jordanShipped = jordanOrders.find((order) => ["shipped", "out_for_delivery", "delivered"].includes(order.deliveryStatus))!;
  const item = (order: { items: { variantId: string }[] }) => [{ variantId: order.items[0].variantId, qty: 1, reason: "Damaged" }];
  assert.equal((await clients.jordan.call("POST", "/api/returns", { body: { orderId: jordanShipped.id, note: "", photoId, items: item(jordanShipped) } })).status, 404, "another customer's photo id is rejected");
  assert.equal((await clients.finance.call("POST", "/api/returns", { body: { orderId: shipped[0].id, note: "", items: item(shipped[0]) } })).status, 403);
  assert.equal((await clients.jordan.call("POST", "/api/returns", { body: { orderId: shipped[0].id, note: "", items: item(shipped[0]) } })).status, 404);
  const created = await clients.customer.call("POST", "/api/returns", { body: { orderId: shipped[0].id, note: "Box dented", photoId, items: item(shipped[0]) } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal((created.body as { photoId: string }).photoId, photoId);
});

test("delivery state machine is enforced on the server", async () => {
  const rows = ((await clients.warehouse.call("GET", "/api/office/orders?limit=100")).body as { items: { id: string; deliveryStatus: string; paymentStatus: string }[] }).items;
  const processing = rows.find((order) => order.deliveryStatus === "processing" && order.paymentStatus === "approved")!;
  const unpaid = rows.find((order) => order.paymentStatus === "declined")!;
  const deliver = (id: string, status: string) => clients.warehouse.call("POST", `/api/office/orders/${id}/delivery`, { body: { status } });
  assert.equal((await deliver(processing.id, "delivered")).status, 409, "cannot skip shipping");
  assert.equal((await deliver(processing.id, "cancelled")).status, 409, "cancellation is not a delivery update");
  assert.equal((await deliver(processing.id, "shipped")).status, 200);
  assert.equal((await deliver(processing.id, "shipped")).status, 409);
  assert.equal((await deliver(unpaid.id, "shipped")).status, 409, "unpaid orders cannot ship");
  const approved = ((await clients.customer.call("GET", "/api/orders?payment=approved")).body as { items: { id: string; paymentStatus: string }[] }).items.find((order) => order.paymentStatus === "approved")!;
  assert.equal((await clients.customer.call("POST", `/api/orders/${approved.id}/authenticate`)).status, 404, "authentication out of sequence is refused");
  const returned = (await readStore((data) => data.orders.find((order) => order.deliveryStatus === "return_requested")))!;
  const stockBefore = await readStore((data) => data.variants.find((variant) => variant.id === returned.items[0].variantId)!.stock);
  assert.equal((await deliver(returned.id, "returned")).status, 200);
  assert.equal((await deliver(returned.id, "returned")).status, 409, "a return is restocked only once");
  const stockAfter = await readStore((data) => data.variants.find((variant) => variant.id === returned.items[0].variantId)!.stock);
  assert.equal(stockAfter, stockBefore + returned.items[0].qty);
});

test("CSRF: forged cross-site or form-encoded requests cannot perform a refund", async () => {
  const order = await placeOrder(clients.customer);
  const refund = (options: CallOptions) => clients.finance.call("POST", "/api/office/refunds", { body: { orderId: order.id, amountCents: 100, reason: "Goodwill" }, ...options });
  assert.equal((await refund({ origin: "https://evil.example" })).status, 403);
  assert.equal((await refund({ origin: null })).status, 403);
  assert.equal((await refund({ headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await refund({ contentType: "text/plain" })).status, 415);
  assert.equal((await refund({ contentType: "application/x-www-form-urlencoded", rawBody: `orderId=${order.id}&amountCents=100&reason=x` })).status, 415);
  assert.equal((await clients.customer.call("POST", `/api/orders/${order.id}/cancel`, { contentType: null })).status, 415);
  assert.equal((await refund({})).status, 200, "the same request from the site itself works");
  assert.ok(logs.some((entry) => entry.type === "csrf.blocked" && entry.status === 403));
});

test("anti-CSRF tokens: every state change needs a valid token for this browser's secret cookie", async () => {
  const order = await placeOrder(clients.customer);
  const body = { orderId: order.id, amountCents: 100, reason: "Goodwill" };
  const refund = (options: ClientCallOptions) => clients.finance.call("POST", "/api/office/refunds", { body, ...options });
  const missing = await refund({ csrf: false });
  assert.equal(missing.status, 403, "no token");
  assert.equal((missing.body as { code: string }).code, "csrf_invalid");
  assert.equal((await refund({ headers: { "x-csrf-token": "AAAAAAAAAAAAAAAA.forged-signature" } })).status, 403, "forged token");
  const other = new Client(freshIp());
  await other.call("GET", "/api/session");
  assert.equal((await refund({ headers: { "x-csrf-token": other.csrf! } })).status, 403, "a token issued to another browser");
  const withoutSecret = clients.finance.cookie.split("; ").filter((pair) => !pair.startsWith(`${CSRF_COOKIE}=`)).join("; ");
  const noCookie = await callRoute(handlers, "POST", "/api/office/refunds", { ip: clients.finance.ip, cookie: withoutSecret, headers: { "x-csrf-token": clients.finance.csrf! }, body });
  assert.equal(noCookie.status, 403, "a valid token without its secret cookie");
  assert.equal((await refund({})).status, 200, "the page's own token works");
  const first = ((await clients.finance.call("GET", "/api/session")).body as { csrfToken: string }).csrfToken;
  const second = ((await clients.finance.call("GET", "/api/session")).body as { csrfToken: string }).csrfToken;
  assert.notEqual(first, second, "each token has its own random salt");
  const sessionToken = clients.finance.jar.get("acme_session")!;
  assert.ok(!first.includes(sessionToken) && !first.includes(clients.finance.jar.get(CSRF_COOKIE)!), "tokens reveal neither the session id nor the secret");
  const fresh = await new Client(freshIp()).call("GET", "/api/session");
  const cookie = fresh.setCookies.find((item) => item.startsWith(`${CSRF_COOKIE}=`))!;
  for (const attribute of [/; HttpOnly/i, /; Secure/i, /; SameSite=strict/i, /; Path=\//i]) assert.match(cookie, attribute);
  assert.ok(logs.some((entry) => entry.type === "csrf.blocked" && entry.status === 403 && entry.detail?.includes("expired")));
});

test("sign-in replaces the anti-CSRF secret and sign-out removes it", async () => {
  const client = new Client(freshIp());
  await client.call("GET", "/api/session");
  const before = client.csrf!;
  const signedIn = await client.call("POST", "/api/auth/login", { body: { email: ACCOUNTS.jordan.email, password: passwords.jordan } });
  assert.equal(signedIn.status, 200);
  assert.ok(client.csrf && client.csrf !== before, "sign-in returns a token for the new secret");
  const stale = await client.call("POST", "/api/wishlist", { body: { variantId: "prd_01_v1" }, headers: { "x-csrf-token": before } });
  assert.equal(stale.status, 403, "a token from before sign-in no longer works");
  assert.equal((await client.call("POST", "/api/wishlist", { body: { variantId: "prd_01_v1" } })).status, 200);
  const signedOut = await client.call("POST", "/api/auth/logout");
  assert.ok(signedOut.setCookies.some((item) => item.startsWith(`${CSRF_COOKIE}=;`) && /Max-Age=0/i.test(item)));
});

type PrivacyBody = {
  accepted: boolean;
  consents: { id: string; granted: boolean; at: string | null }[];
  restrictions: { id: string; restricted: boolean; at: string | null }[];
  activities: { id: string; allowed: boolean }[];
};

const SHIPPING = { fullName: "Jordan Lee", line1: "18 Market Street", city: "San Francisco", region: "CA", postalCode: "94105", country: "US" };

function decide(client: Client, decision: "accept" | "decline", consents: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return client.call("POST", "/api/account/privacy", { body: { decision, noticeVersion: PRIVACY_NOTICE_VERSION, language: "en", consents, ...extra } });
}

test("privacy T178: personal data is collected only after the current notice is accepted; decisions are stored with proof", async () => {
  // One session per account: sign Jordan in again (the previous test signed out).
  const client = new Client(freshIp());
  assert.equal((await client.call("POST", "/api/auth/login", { body: { email: ACCOUNTS.jordan.email, password: passwords.jordan } })).status, 200);
  assert.equal((await client.call("POST", "/api/auth/step-up", { body: { password: passwords.jordan } })).status, 200);
  clients.jordan = client;
  const declined = await decide(client, "decline", { marketing_email: true }, { language: "pt-BR" });
  assert.equal(declined.status, 200);
  assert.equal((declined.body as PrivacyBody).accepted, false);
  assert.ok((declined.body as PrivacyBody).consents.every((item) => !item.granted), "Decline grants nothing, whatever was ticked");
  const checkout = await client.call("POST", "/api/checkout", { body: { shippingMethod: "standard", address: SHIPPING } });
  assert.equal(checkout.status, 409, "no shipping address without an accepted notice");
  assert.equal((checkout.body as { code: string }).code, "consent_required");
  assert.equal((await client.call("PATCH", "/api/account", { body: { fullName: "Jordan Lee", phone: "" } })).status, 409, "no profile data without an accepted notice");
  assert.equal((await decide(client, "accept", {}, { noticeVersion: "2020-01-01" })).status, 409, "a decision on an outdated notice is refused");
  assert.equal((await decide(client, "accept", { sell_my_data: true })).status, 400, "only items of the privacy register exist");
  const accepted = await decide(client, "accept", { marketing_email: true }, { language: "pt-BR" });
  assert.equal(accepted.status, 200);
  const state = accepted.body as PrivacyBody;
  assert.equal(state.accepted, true);
  assert.deepEqual(state.consents.map((item) => [item.id, item.granted]), [["delivery_phone", false], ["marketing_email", true]], "each optional item is opted in on its own; unticked stays off");
  const proof = await readStore((data) => data.consentLog.filter((entry) => entry.userId === "usr_06"));
  const last = proof.at(-1)!;
  assert.equal(last.action, "accept");
  assert.deepEqual(last.items, ["marketing_email"]);
  assert.equal(last.noticeVersion, PRIVACY_NOTICE_VERSION);
  assert.equal(last.language, "pt-BR");
  assert.match(last.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(last.evidence.ip, client.ip);
  assert.ok(sha256(client.jar.get("acme_session")!).startsWith(last.evidence.sessionRef), "the decision is tied to the signed-in session");
  assert.ok(proof.some((entry) => entry.action === "decline"), "a decline is recorded too");
  // A new notice version (for example a new purpose) asks again: older acceptances and consents stop counting.
  await updateStore((data) => {
    data.privacy.find((item) => item.userId === "usr_06")!.noticeVersion = "2026-01-01";
  });
  assert.equal((await client.call("PATCH", "/api/account", { body: { fullName: "Jordan Lee", phone: "" } })).status, 409);
  const outdated = (await client.call("GET", "/api/account/privacy")).body as PrivacyBody;
  assert.equal(outdated.accepted, false);
  assert.ok(outdated.consents.every((item) => !item.granted), "consent given for an older notice no longer counts");
  assert.equal((await decide(client, "accept")).status, 200);
  assert.equal((await client.call("PATCH", "/api/account", { body: { fullName: "Jordan Lee", phone: "" } })).status, 200);
});

test("privacy T604: consents are listed from the store and withdrawing one stops the activity", async () => {
  const customer = clients.customer;
  const granted = await customer.call("PATCH", "/api/account/privacy/consents", { body: { marketing_email: true, delivery_phone: true } });
  assert.equal(granted.status, 200);
  assert.ok((granted.body as PrivacyBody).consents.every((item) => item.granted && item.at));
  assert.equal((await customer.call("PATCH", "/api/account", { body: { fullName: "Avery Chen", phone: "+1 415 555 0100" } })).status, 200);
  const order = await placeOrder(customer);
  const warehouseView = (await clients.warehouse.call("GET", `/api/orders/${order.id}`)).body as { order: { contactPhone?: string } };
  assert.equal(warehouseView.order.contactPhone, "+1 415 555 0100", "fulfilment gets the phone while consent is given");
  const financeView = (await clients.finance.call("GET", `/api/orders/${order.id}`)).body as { order: { contactPhone?: string } };
  assert.equal(financeView.order.contactPhone, undefined, "only fulfilment receives the phone");
  clearDevOutbox();
  assert.equal((await clients.catalog.call("POST", "/api/office/products/prd_01/announce")).status, 200);
  const mail = devOutbox().find((item) => item.to === ACCOUNTS.customer.email);
  assert.ok(mail && mail.text.includes("/account/privacy"), "product e-mails reach customers who opted in and explain how to withdraw");
  assert.equal(mail.headers["List-Unsubscribe"], "<http://localhost:3000/account/privacy>", "bulk e-mail carries an unsubscribe mechanism");
  assert.ok(mail.text.includes(MAIL_FOOTER), "standard disclaimer and anti-phishing notice");
  assert.ok(!devOutbox().some((item) => item.to === ACCOUNTS.finance.email), "staff accounts are not marketed to");
  const withdrawn = await customer.call("PATCH", "/api/account/privacy/consents", { body: { marketing_email: false, delivery_phone: false } });
  assert.equal(withdrawn.status, 200);
  assert.ok((withdrawn.body as PrivacyBody).consents.every((item) => !item.granted && item.at));
  clearDevOutbox();
  assert.equal((await clients.catalog.call("POST", "/api/office/products/prd_01/announce")).status, 200);
  assert.ok(!devOutbox().some((item) => item.to === ACCOUNTS.customer.email), "no product e-mail after withdrawal");
  const after = (await clients.warehouse.call("GET", `/api/orders/${order.id}`)).body as { order: { contactPhone?: string; address?: unknown } };
  assert.equal(after.order.contactPhone, undefined, "the phone is no longer shared");
  assert.ok(after.order.address, "data needed for the order is kept");
  assert.equal((await customer.call("PATCH", "/api/account", { body: { fullName: "Avery Chen", phone: "+1 415 555 0199" } })).status, 409, "a new phone number is not collected without consent");
  const log = await readStore((data) => data.consentLog.filter((entry) => entry.userId === "usr_01" && entry.action === "withdraw"));
  assert.deepEqual([...log.at(-1)!.items].sort(), ["delivery_phone", "marketing_email"]);
  assert.ok(logs.some((entry) => entry.type === "privacy.withdraw" && entry.actorId === "usr_01"));
  assert.equal((await customer.call("PATCH", "/api/account/privacy/consents", { body: { location_tracking: true } })).status, 400);
  assert.equal((await customer.call("PATCH", "/api/account/privacy/consents", { body: {} })).status, 400);
});

test("privacy T754: a restricted activity stops for that user even with consent, and resumes when lifted", async () => {
  const customer = clients.customer;
  await customer.call("PATCH", "/api/account/privacy/consents", { body: { marketing_email: true, delivery_phone: true } });
  const restricted = await customer.call("PATCH", "/api/account/privacy/restrictions", { body: { marketing_email: true, delivery_phone: true, order_tracking_feed: true } });
  assert.equal(restricted.status, 200);
  const view = restricted.body as PrivacyBody;
  assert.deepEqual(view.restrictions.map((item) => [item.id, item.restricted]), [["delivery_phone", true], ["marketing_email", true], ["order_tracking_feed", true]]);
  assert.deepEqual(view.activities.filter((item) => !item.allowed).map((item) => item.id).sort(), ["delivery_phone", "marketing_email", "order_tracking_feed"], "the account's checklist of allowed activities");
  clearDevOutbox();
  await clients.catalog.call("POST", "/api/office/products/prd_02/announce");
  assert.ok(!devOutbox().some((item) => item.to === ACCOUNTS.customer.email), "restricted marketing does not run although consent is given");
  const orders = ((await customer.call("GET", "/api/orders?limit=1")).body as { items: { id: string }[] }).items;
  const fulfilment = (await clients.warehouse.call("GET", `/api/orders/${orders[0].id}`)).body as { order: { contactPhone?: string } };
  assert.equal(fulfilment.order.contactPhone, undefined, "a restricted phone is not shared");
  const plan = await readStore((data) => orderFeedPlan(data));
  assert.ok(plan.purge.includes("usr_01") && !plan.rows.some((row) => row.user_id === "usr_01"), "restricted orders leave the realtime feed");
  const lifted = await customer.call("PATCH", "/api/account/privacy/restrictions", { body: { marketing_email: false, delivery_phone: false, order_tracking_feed: false } });
  assert.ok((lifted.body as PrivacyBody).activities.every((item) => item.allowed));
  clearDevOutbox();
  await clients.catalog.call("POST", "/api/office/products/prd_02/announce");
  assert.ok(devOutbox().some((item) => item.to === ACCOUNTS.customer.email), "the activity resumes once the restriction is lifted");
  const resumed = await readStore((data) => orderFeedPlan(data));
  assert.ok(!resumed.purge.includes("usr_01") && resumed.rows.some((row) => row.user_id === "usr_01"));
  const actions = await readStore((data) => data.consentLog.filter((entry) => entry.userId === "usr_01").map((entry) => entry.action));
  assert.ok(actions.includes("restrict") && actions.includes("lift_restriction"), "restriction requests are recorded");
  await customer.call("PATCH", "/api/account/privacy/consents", { body: { marketing_email: false, delivery_phone: false } });
});

async function expireStepUp(client: Client) {
  const tokenHash = sha256(client.jar.get("acme_session")!);
  await updateStore((data) => {
    data.sessions.find((item) => item.tokenHash === tokenHash)!.stepUpAt = new Date(Date.now() - 11 * 60_000).toISOString();
  });
}

test("step-up T338: a refund needs a recent second factor; the session ticket is reissued and codes cannot be replayed", async () => {
  const finance = new Client(freshIp());
  assert.equal((await finance.call("POST", "/api/auth/login", { body: { email: ACCOUNTS.finance.email, password: passwords.finance } })).status, 200);
  clients.finance = finance;
  const order = await placeOrder(clients.customer);
  const refund = () => finance.call("POST", "/api/office/refunds", { body: { orderId: order.id, amountCents: 100, reason: "Goodwill" } });
  const blocked = await refund();
  assert.equal(blocked.status, 403, "a new session has not confirmed a second factor yet");
  assert.equal((blocked.body as { code: string }).code, "step_up_required");
  assert.equal((await finance.call("POST", "/api/auth/step-up", { body: { password: passwords.finance } })).status, 400, "staff cannot use the password as the additional factor");
  const before = finance.jar.get("acme_session")!;
  const code = totpCode(mfaSecrets.finance, Date.now() + 30_000);
  assert.equal((await finance.call("POST", "/api/auth/step-up", { body: { code } })).status, 200);
  const after = finance.jar.get("acme_session")!;
  assert.notEqual(after, before, "a new session ticket is issued at the privilege change");
  assert.equal((await callRoute(handlers, "GET", "/api/orders", { cookie: `acme_session=${before}`, ip: finance.ip })).status, 401, "the previous ticket no longer works");
  assert.equal((await refund()).status, 200, "the refund goes through after the second factor");
  assert.equal((await finance.call("POST", "/api/auth/step-up", { body: { code } })).status, 401, "a code cannot be used twice");
  await expireStepUp(finance);
  assert.equal(((await refund()).body as { code: string }).code, "step_up_required", "the confirmation expires");
  assert.ok(logs.some((entry) => entry.type === "auth.step_up" && entry.outcome === "success" && entry.detail === "totp"));
  assert.ok(logs.some((entry) => entry.type === "authz.denied" && entry.detail?.includes("requires additional authentication")));
});

test("step-up T338: customers confirm personal-data changes with their password, or with their second factor once enrolled", async () => {
  const client = new Client(freshIp());
  assert.equal((await client.call("POST", "/api/auth/login", { body: { email: ACCOUNTS.jordan.email, password: passwords.jordan } })).status, 200);
  clients.jordan = client;
  const change = () => client.call("PATCH", "/api/account", { body: { fullName: "Jordan Lee", phone: "" } });
  assert.equal(((await change()).body as { code: string }).code, "step_up_required", "profile changes are critical");
  assert.equal((await client.call("POST", "/api/auth/step-up", { body: { password: "Wrong-Password-81!" } })).status, 401);
  assert.equal((await client.call("POST", "/api/auth/step-up", { body: { password: passwords.jordan } })).status, 200);
  assert.equal((await change()).status, 200);
  const setup = await client.call("POST", "/api/account/mfa/setup");
  assert.equal(setup.status, 200);
  const secret = (setup.body as { secret: string; otpauthUri: string }).secret;
  const enabled = await client.call("POST", "/api/account/mfa/enable", { body: { code: totpCode(secret) } });
  assert.equal(enabled.status, 200);
  const recovery = (enabled.body as { recoveryCodes: string[] }).recoveryCodes;
  assert.equal(recovery.length, 8);
  await expireStepUp(client);
  assert.equal((await client.call("POST", "/api/auth/step-up", { body: { password: passwords.jordan } })).status, 400, "with a second factor the password alone is not enough");
  assert.equal((await client.call("POST", "/api/auth/step-up", { body: { code: recovery[0] } })).status, 200, "a recovery code works");
  await expireStepUp(client);
  assert.equal((await client.call("POST", "/api/auth/step-up", { body: { code: recovery[0] } })).status, 401, "but only once");
  const stored = await readStore((data) => JSON.stringify(data.users.find((user) => user.id === "usr_06")!.mfa));
  assert.ok(recovery.every((item) => !stored.includes(item)), "recovery codes are stored only as hashes");
  const session = (await client.call("GET", "/api/session")).body as { user: { mfaEnabled: boolean } };
  assert.equal(session.user.mfaEnabled, true);
});

test("step-up T338: staff without a second factor must enrol before critical actions and cannot turn it off", async () => {
  await updateStore((data) => {
    data.users.find((user) => user.id === "usr_02")!.mfa = null;
  });
  const catalog = new Client(freshIp());
  assert.equal((await catalog.call("POST", "/api/auth/login", { body: { email: ACCOUNTS.catalog.email, password: passwords.catalog } })).status, 200);
  const announce = await catalog.call("POST", "/api/office/products/prd_01/announce");
  assert.equal(announce.status, 403);
  assert.equal((announce.body as { code: string }).code, "mfa_enrollment_required");
  assert.equal((await catalog.call("POST", "/api/auth/step-up", { body: { password: passwords.catalog } })).status, 403);
  const disabled = await clients.administrator.call("POST", "/api/account/mfa/disable");
  assert.equal(disabled.status, 403, "staff accounts keep two-step verification");
});

test("message size limits are enforced before the body is parsed", async () => {
  const client = clients.customer;
  const big = { variantId: "prd_01_v1", qty: 1, padding: "x".repeat(20_000) };
  assert.equal((await client.call("POST", "/api/cart", { body: big })).status, 413);
  assert.equal((await client.call("POST", "/api/cart", { body: { variantId: "prd_01_v1", qty: 1 }, headers: { "content-length": "99999999" } })).status, 413);
  let pulled = 0;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 4096;
      controller.enqueue(new Uint8Array(4096).fill(0x20));
    },
  });
  assert.equal((await client.call("POST", "/api/cart", { rawBody: endless })).status, 413);
  assert.ok(pulled <= 16 * 1024 + 3 * 4096, `read ${pulled} bytes of an endless body`);
  const upload = new FormData();
  upload.set("file", new File([new Uint8Array(3_000_000)], "big.png"));
  assert.equal((await client.call("POST", "/api/uploads", { rawBody: upload, contentType: null, headers: { "x-requested-with": "fetch" } })).status, 413);
  assert.equal((await client.call("POST", "/api/cart", { rawBody: new Uint8Array([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d]) })).status, 400, "malformed UTF-8");
  assert.equal((await client.call("POST", "/api/cart", { body: { variantId: "prd\u0000_01", qty: 1 } })).status, 400, "NUL characters");
  assert.equal((await client.call("GET", "/api/catalog?q=%00")).status, 400);
  assert.equal((await client.call("GET", `/api/catalog?q=${"y".repeat(500)}`)).status, 400);
  assert.equal((await client.call("POST", "/api/cart", { body: { variantId: "prd_01_v1", qty: 1 } })).status, 200, "the service keeps working");
});

test("logout clears browser data and the server-side session", async () => {
  const account = ACCOUNTS.customer;
  const client = new Client(freshIp());
  const login = await client.call("POST", "/api/auth/login", { body: { email: account.email, password: passwords.customer } });
  const sessionCookie = login.setCookies.find((item) => item.startsWith("acme_session="))!;
  assert.match(sessionCookie, /; Secure/i);
  assert.match(sessionCookie, /; HttpOnly/i);
  assert.match(sessionCookie, /; SameSite=lax/i);
  assert.match(sessionCookie, /; Path=\//i);
  const stolen = client.cookie;
  const logout = await client.call("POST", "/api/auth/logout");
  assert.equal(logout.headers.get("clear-site-data"), '"cache", "cookies", "storage"');
  for (const name of ["acme_session", "acme_cart", "acme_mail", CSRF_COOKIE]) {
    assert.ok(logout.setCookies.some((item) => item.startsWith(`${name}=;`) && /Max-Age=0/i.test(item)), `${name} expired`);
  }
  const replay = await callRoute(handlers, "GET", "/api/orders", { cookie: stolen, ip: client.ip });
  assert.equal(replay.status, 401, "a captured session cookie no longer works after logout");
});

test("authentication errors are identical for unknown accounts, wrong passwords and locked accounts", async () => {
  const client = new Client(freshIp());
  const unknown = await client.call("POST", "/api/auth/login", { body: { email: "nobody@acme-retail.test", password: "Some-Password-81!" } });
  const wrong = await client.call("POST", "/api/auth/login", { body: { email: ACCOUNTS.jordan.email, password: "Some-Password-81!" } });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.status, wrong.status);
  assert.deepEqual(unknown.body, wrong.body);
  assert.deepEqual(unknown.setCookies, []);
  assert.deepEqual(wrong.setCookies, []);
});

test("account lockout: after five wrong passwords even the right one is refused", async () => {
  const client = new Client(freshIp());
  const email = "sam.patel@acme-retail.test";
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await client.call("POST", "/api/auth/login", { body: { email, password: "Wrong-Guess-81!" } })).status, 401);
  }
  const locked = await client.call("POST", "/api/auth/login", { body: { email, password: SEED_PASSWORD } });
  assert.equal(locked.status, 401);
  assert.deepEqual(locked.body, { error: "Email or password is incorrect.", code: "unauthorized" });
});

/** Requests a password reset the way the recover page does: solve the anti-automation challenge first. */
async function recover(client: Client, email: string) {
  const challenge = (await client.call("POST", "/api/auth/challenge")).body as { id: string; salt: string; difficulty: number };
  return client.call("POST", "/api/auth/recover", { body: { email, challengeId: challenge.id, nonce: await solvePow(challenge.salt, challenge.difficulty) } });
}

test("anti-automation T2: a reset request needs a solved, unused, unexpired proof-of-work challenge", async () => {
  const client = new Client(freshIp());
  const email = ACCOUNTS.customer.email;
  assert.equal((await client.call("POST", "/api/auth/recover", { body: { email } })).status, 400, "no challenge");
  const issued = await client.call("POST", "/api/auth/challenge");
  assert.equal(issued.status, 200);
  const challenge = issued.body as { id: string; salt: string; difficulty: number; expiresAt: string };
  assert.ok(challenge.difficulty >= 16, "about 65,000 hashes on average per request");
  const unsolved = await client.call("POST", "/api/auth/recover", { body: { email, challengeId: challenge.id, nonce: "1" } });
  assert.deepEqual([unsolved.status, (unsolved.body as { code: string }).code], [400, "challenge_failed"]);
  const nonce = await solvePow(challenge.salt, challenge.difficulty);
  assert.equal((await client.call("POST", "/api/auth/recover", { body: { email, challengeId: challenge.id, nonce } })).status, 200);
  assert.equal((await client.call("POST", "/api/auth/recover", { body: { email, challengeId: challenge.id, nonce } })).status, 400, "a challenge works only once");
  const late = (await client.call("POST", "/api/auth/challenge")).body as { id: string; salt: string; difficulty: number };
  await updateStore((data) => {
    data.challenges.find((item) => item.id === late.id)!.expiresAt = new Date(Date.now() - 1000).toISOString();
  });
  assert.equal((await client.call("POST", "/api/auth/recover", { body: { email, challengeId: late.id, nonce: await solvePow(late.salt, late.difficulty) } })).status, 400, "an expired challenge is refused");
  assert.ok(logs.some((entry) => entry.type === "auth.challenge_failed"));
});

test("password recovery: generic answer, no cookie, link only in the registered mailbox, throttled", async () => {
  clearDevOutbox();
  const client = new Client(freshIp());
  const existing = await recover(client, ACCOUNTS.jordan.email);
  const unknown = await recover(client, "nobody@acme-retail.test");
  assert.equal(existing.status, 200);
  assert.deepEqual(existing.body, unknown.body);
  assert.deepEqual(existing.setCookies, []);
  assert.deepEqual(unknown.setCookies, []);
  assert.ok(!existing.text.includes("token"), "the requester never receives the link");
  assert.equal(devOutbox().length, 1);
  assert.equal(devOutbox()[0].to, ACCOUNTS.jordan.email);
  assert.ok(devOutbox()[0].text.endsWith(MAIL_FOOTER) && devOutbox()[0].category === "transactional", "every e-mail carries the disclaimer");
  const token = /#token=([a-f0-9]+)/.exec(devOutbox()[0].text)![1];
  const statuses: number[] = [];
  for (let i = 0; i < 10; i += 1) statuses.push((await recover(client, `guess${i}@acme-retail.test`)).status);
  assert.ok(statuses.includes(429), "repeated attempts are blocked");
  const next = testPassword({ email: ACCOUNTS.jordan.email, name: ACCOUNTS.jordan.name });
  assert.equal((await new Client(freshIp()).call("POST", "/api/auth/reset", { body: { token, password: next } })).status, 200);
  assert.equal((await new Client(freshIp()).call("POST", "/api/auth/login", { body: { email: ACCOUNTS.jordan.email, password: next } })).status, 200);
});

test("throttling per client IP on sign-in and on read endpoints", async () => {
  const attacker = new Client(freshIp());
  const statuses: number[] = [];
  for (let i = 0; i < 11; i += 1) {
    statuses.push((await attacker.call("POST", "/api/auth/login", { body: { email: `probe${i}@acme-retail.test`, password: "Probe-Pass-81!" } })).status);
  }
  assert.equal(statuses[9], 401);
  assert.equal(statuses[10], 429);
  assert.equal((await new Client(freshIp()).call("POST", "/api/auth/login", { body: { email: "probe@acme-retail.test", password: "Probe-Pass-81!" } })).status, 401, "other clients are not affected");
  const scraper = new Client(freshIp());
  let last = 0;
  for (let i = 0; i < 901; i += 1) last = (await scraper.call("GET", "/api/session")).status;
  assert.equal(last, 429);
  assert.ok(logs.some((entry) => entry.type === "rate_limit.exceeded"));
});

test("throttling T1362: authentication limits are shared through the data store and survive a restart", async () => {
  const attacker = new Client(freshIp());
  const attempt = (i: number) => attacker.call("POST", "/api/auth/login", { body: { email: `shared${i}@acme-retail.test`, password: "Probe-Pass-81!" } });
  for (let i = 0; i < 10; i += 1) assert.equal((await attempt(i)).status, 401);
  resetRateLimits(); // another server instance, or this one after a restart, starts with an empty in-memory limiter
  const blocked = await attempt(10);
  assert.equal(blocked.status, 429, "the shared counter still blocks the IP");
  assert.equal(blocked.headers.get("retry-after"), "900");
  const victim = "sam.patel@acme-retail.test";
  for (let i = 0; i < 10; i += 1) {
    const probe = await recover(new Client(freshIp()), i % 2 ? victim.toUpperCase() : victim);
    assert.equal(probe.status, i < 5 ? 200 : 429, `recovery request ${i + 1} for one account from a new IP`);
    resetRateLimits();
  }
  const stored = await readStore((data) => JSON.stringify(data.throttle));
  assert.ok(!stored.includes(attacker.ip) && !stored.includes("shared0") && !stored.includes("sam.patel"), "counters are stored as hashes");
  assert.ok(logs.some((entry) => entry.type === "rate_limit.exceeded" && entry.detail?.includes("shared")));
});

test("throttling T1362: one account has a request budget whatever IP addresses it uses", async () => {
  const customer = new Client(freshIp());
  assert.equal((await customer.call("POST", "/api/auth/login", { body: { email: ACCOUNTS.customer.email, password: passwords.customer } })).status, 200);
  clients.customer = customer;
  let last = 0;
  let sent = 0;
  for (let i = 0; i <= USER_LIMITS.write && last !== 429; i += 1) {
    const hop = new Client(freshIp());
    hop.jar = new Map(customer.jar);
    hop.csrf = customer.csrf;
    last = (await hop.call("POST", "/api/wishlist", { body: { variantId: "prd_01_v1" } })).status;
    sent += 1;
  }
  assert.equal(last, 429, "the per-account tier stops the account");
  assert.ok(sent <= USER_LIMITS.write + 1);
  assert.ok(logs.some((entry) => entry.type === "rate_limit.exceeded" && entry.detail === "user-write: per account"));
  resetRateLimits();
});

test("audit trail T349: administrators read it without changing it and tampering is detected", async () => {
  type Trail = { integrity: { ok: boolean; checked: number; brokenAt: string | null }; items: { id: string; type: string }[] };
  const first = await clients.administrator.call("GET", "/api/office/audit?limit=100");
  assert.equal(first.status, 200);
  const body = first.body as Trail;
  assert.equal(body.integrity.ok, true);
  assert.ok(body.integrity.checked > 20 && body.items.length === 100);
  assert.equal((await clients.finance.call("GET", "/api/office/audit")).status, 403, "only the oversight duty reads the trail");
  const target = body.items.find((item) => item.type === "auth.success")!;
  const original = await readStore((data) => data.events.find((event) => event.id === target.id)!.message);
  await updateStore((data) => {
    data.events.find((event) => event.id === target.id)!.message = "Nothing happened.";
  });
  const tampered = (await clients.administrator.call("GET", "/api/office/audit")).body as Trail;
  assert.deepEqual([tampered.integrity.ok, tampered.integrity.brokenAt], [false, target.id], "a changed entry breaks the chain");
  assert.ok(logs.some((entry) => entry.type === "audit.integrity_failed"));
  await updateStore((data) => {
    data.events.find((event) => event.id === target.id)!.message = original;
  });
  assert.equal(((await clients.administrator.call("GET", "/api/office/audit")).body as Trail).integrity.ok, true);
  assert.equal(matchApiRoute("DELETE", ["office", "audit"]), null, "no route changes or deletes the trail");
  assert.equal(matchApiRoute("POST", ["office", "audit"]), null);
});

test("unexpected errors answer generically with an id that matches the log entry", async () => {
  const original = globalThis.structuredClone;
  globalThis.structuredClone = (() => {
    throw new Error("simulated failure reading C:\\srv\\secret\\store.json");
  }) as typeof structuredClone;
  let result: CallResult;
  try {
    result = await new Client(freshIp()).call("GET", "/api/catalog");
  } finally {
    globalThis.structuredClone = original;
  }
  assert.equal(result.status, 500);
  const body = result.body as { error: string; errorId: string };
  assert.equal(body.error, "Something went wrong. Please try again.");
  assert.ok(!result.text.includes("secret") && !result.text.includes("store.json"));
  assert.ok(logs.some((entry) => entry.errorId === body.errorId && entry.detail?.includes("simulated failure")));
  const invalid = await new Client(freshIp()).call("GET", "/api/catalog?sort=drop%20table");
  assert.deepEqual(invalid.body, { error: "Check the form and try again.", code: "invalid_input" });
  assert.ok(logs.some((entry) => entry.type === "input.invalid"));
});

test("accounts with the initial password can only change it", async () => {
  await resetStore();
  const client = new Client(freshIp());
  await client.call("POST", "/api/auth/login", { body: { email: ACCOUNTS.customer.email, password: SEED_PASSWORD } });
  const blocked = await client.call("GET", "/api/orders");
  assert.equal(blocked.status, 403);
  assert.equal((blocked.body as { code: string }).code, "password_change_required");
  assert.equal((await client.call("GET", "/api/session")).status, 200);
});

test("the simulated payment outcome is not client-controlled when demo scenarios are disabled", async () => {
  await resetStore();
  await activate("customer");
  process.env.ACME_DEMO_MODE = "disabled";
  try {
    const order = await placeOrder(clients.customer, "declined");
    assert.equal(order.paymentStatus, "approved", "the administrator's default applies");
  } finally {
    delete process.env.ACME_DEMO_MODE;
  }
});

test("parameter tampering: strong types, bounded values and no mass assignment", async () => {
  const client = clients.customer;
  for (const body of [{ variantId: "prd_01_v1", qty: "1" }, { variantId: "prd_01_v1", qty: 11 }, { variantId: "../../etc/passwd", qty: 1 }, { variantId: "prd_01_v1" }]) {
    const result = await client.call("POST", "/api/cart", { body });
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.deepEqual(result.body, { error: "Check the form and try again.", code: "invalid_input" });
  }
  const profile = await client.call("PATCH", "/api/account", { body: { fullName: "Avery Chen", phone: "", marketingOptIn: true, role: "administrator", mustChangePassword: false, id: "usr_05" } });
  assert.equal(profile.status, 200);
  const session = (await client.call("GET", "/api/session")).body as { user: { id: string; role: string }; permissions: string[] };
  assert.equal(session.user.role, "customer", "extra fields are ignored");
  assert.equal(session.user.id, "usr_01");
  assert.deepEqual(session.permissions, ["orders.purchase"]);
  const consents = ((await client.call("GET", "/api/account/privacy")).body as { consents: { id: string; granted: boolean }[] }).consents;
  assert.ok(consents.every((item) => !item.granted), "consent cannot be given through the profile");
});

test("every state-changing call leaves an audit record with user, UTC time, IP, action and outcome", () => {
  const records = logs.filter((entry) => entry.type === "api.transaction");
  assert.ok(records.length > 50);
  for (const record of records) {
    assert.match(record.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(record.ip && record.method && record.path && record.detail);
    assert.equal(typeof record.status, "number");
    assert.equal(record.outcome, record.status! < 400 ? "success" : "failure");
  }
  assert.ok(records.some((record) => record.actorId === "usr_04" && record.detail === "POST office/refunds" && record.outcome === "success"));
  assert.ok(records.some((record) => record.status === 403 && record.outcome === "failure"));
});

test("logs never contain passwords or tokens", () => {
  const secrets = [SEED_PASSWORD, ...Object.values(passwords)];
  const text = JSON.stringify(logs);
  for (const secret of secrets) assert.ok(!text.includes(secret), "a password reached the log");
  for (const client of Object.values(clients)) {
    const token = client.jar.get("acme_session");
    if (token) assert.ok(!text.includes(token), "a session token reached the log");
  }
  assert.doesNotMatch(text, /token=[a-f0-9]{20,}/);
});

test("the API sheds load with 503 while the event loop is blocked", async () => {
  const until = Date.now() + 2000;
  while (Date.now() < until) {
    // Simulate a CPU-bound stall on the event loop.
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  const busy = await new Client(freshIp()).call("GET", "/api/catalog");
  assert.equal(busy.status, 503);
  assert.equal(busy.headers.get("retry-after"), "5");
  assert.ok(logs.some((entry) => entry.type === "server.busy"));
  await new Promise((resolve) => setTimeout(resolve, 2200));
  assert.equal((await new Client(freshIp()).call("GET", "/api/catalog")).status, 200);
});

test("absolute URLs for third parties come from APP_ORIGIN, never from the Host header", () => {
  const forged = new Request("http://evil.example/api/checkout", { headers: { host: "evil.example" } });
  process.env.APP_ORIGIN = "https://shop.example";
  try {
    assert.equal(trustedOrigin(forged), "https://shop.example");
  } finally {
    delete process.env.APP_ORIGIN;
  }
  const env = process.env as Record<string, string | undefined>;
  const previous = env.NODE_ENV;
  env.NODE_ENV = "production";
  try {
    assert.throws(() => trustedOrigin(forged), (error: unknown) => error instanceof AppError && error.status === 503);
  } finally {
    env.NODE_ENV = previous;
  }
});

test("CSP violation reports are accepted and logged", async () => {
  const result = await callRoute(handlers, "POST", "/api/csp-report", {
    origin: null,
    contentType: "application/csp-report",
    rawBody: JSON.stringify({ "csp-report": { "document-uri": "https://shop.example/", "blocked-uri": "inline", "violated-directive": "script-src-elem" } }),
  });
  assert.equal(result.status, 204);
  assert.ok(logs.some((entry) => entry.type === "csp.violation" && entry.detail?.includes("script-src-elem")));
});

test("no API response ever contains credentials, token hashes or lockout state", () => {
  assert.ok(bodies.length > 100);
  assert.deepEqual([...findKeys(bodies, SECRET_KEYS)], []);
});

test("information exposure: every response of this run matched its declared schema and DTOs drop internal fields", async () => {
  assert.deepEqual(logs.filter((entry) => entry.type === "response.schema_violation").map((entry) => entry.detail), [], "no response broke its contract");
  assert.deepEqual([...findKeys(bodies, ["userId", "cartId", "productId", "evidence", "consentLog"])], [], "internal fields never reach any response");
  const orders = ((await clients.customer.call("GET", "/api/orders")).body as { items: Record<string, unknown>[] }).items;
  assert.ok(orders.length > 0 && orders.every((order) => !("paymentScenario" in order) && !("userId" in order)), "customer orders omit internal fields");
  const catalog = (await new Client(freshIp()).call("GET", "/api/catalog")).body as { products: { variants: Record<string, unknown>[] }[] };
  assert.deepEqual(Object.keys(catalog.products[0].variants[0]).sort(), ["available", "id", "label", "options", "priceCents"], "public variants show availability, not stock bookkeeping");
  const cart = (await new Client(freshIp()).call("GET", "/api/cart")).body as Record<string, unknown>;
  assert.equal("id" in cart, false, "the cart cookie value is not echoed in the body");
});
