import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  API_ROUTES,
  CONFLICTING_DUTIES,
  PROTECTED_PAGES,
  PUBLIC_PAGES,
  can,
  canCancelOrder,
  canRefundOrder,
  canRequestReturn,
  canViewOrder,
  matchApiRoute,
  pageAccess,
  permissionsOf,
} from "./policy";
import { ROLES } from "./types";

test("least privilege: each role holds only the permissions its job needs", () => {
  assert.deepEqual(permissionsOf("customer"), ["orders.purchase"]);
  assert.deepEqual(permissionsOf("catalog"), ["catalog.manage"]);
  assert.deepEqual(permissionsOf("warehouse").sort(), ["inventory.adjust", "inventory.view", "orders.fulfil", "orders.view"]);
  assert.deepEqual(permissionsOf("finance").sort(), ["orders.cancel_any", "orders.view", "refunds.issue", "refunds.view"]);
  assert.deepEqual(permissionsOf("administrator").sort(), ["events.view", "inventory.view", "orders.view", "refunds.view", "scenarios.manage"]);
  assert.equal(can("catalog", "orders.view"), false, "catalog must not read orders");
  assert.equal(can("administrator", "refunds.issue"), false, "administrator is oversight, not finance");
});

test("separation of duties: no role combines conflicting duties", () => {
  for (const role of ROLES) {
    for (const [first, second] of CONFLICTING_DUTIES) {
      assert.ok(!(can(role, first) && can(role, second)), `${role} holds ${first} and ${second}`);
    }
  }
  const order = { userId: "usr_04" };
  assert.equal(canRefundOrder({ id: "usr_04", role: "finance" }, order), false, "no self-refund");
  assert.equal(canRefundOrder({ id: "usr_99", role: "finance" }, order), true);
  assert.equal(canCancelOrder({ id: "usr_03", role: "warehouse" }, order), false, "warehouse cannot cancel with refund");
  assert.equal(canCancelOrder({ id: "usr_02", role: "catalog" }, order), false);
  assert.equal(canCancelOrder({ id: "usr_99", role: "finance" }, order), true);
});

test("object-level rules use the actor id from the session, not ownership claims", () => {
  const order = { userId: "usr_01" };
  assert.equal(canViewOrder({ id: "usr_01", role: "customer" }, order), true);
  assert.equal(canViewOrder({ id: "usr_06", role: "customer" }, order), false);
  assert.equal(canViewOrder({ id: "usr_02", role: "catalog" }, order), false);
  assert.equal(canRequestReturn({ id: "usr_04", role: "finance" }, order), false);
  assert.equal(canRequestReturn({ id: "usr_01", role: "customer" }, order), true);
});

test("API routes are an explicit allow-list and unknown routes match nothing", () => {
  const keys = API_ROUTES.map((route) => `${route.method} ${route.path}`);
  assert.equal(new Set(keys).size, keys.length, "duplicate route declarations");
  assert.equal(matchApiRoute("GET", ["mail"]), null, "the simulated mailbox endpoint was removed");
  assert.equal(matchApiRoute("DELETE", ["orders"]), null);
  assert.equal(matchApiRoute("GET", ["office", "orders", "x", "y"]), null);
  const publicRoutes = API_ROUTES.filter((route) => route.access === "public").map((route) => `${route.method} ${route.path}`);
  assert.deepEqual(publicRoutes.sort(), [
    "GET cart",
    "GET catalog",
    "GET products/:slug",
    "GET session",
    "POST auth/challenge",
    "POST auth/login",
    "POST auth/logout",
    "POST auth/recover",
    "POST auth/reset",
    "POST cart",
    "POST csp-report",
    "POST webhooks/stripe",
  ]);
});

test("pages: only the white-listed pages are public and unknown pages need a session", () => {
  for (const page of ["/", "/catalog", "/product/merino-crew-tee", "/cart", "/login", "/recover", "/reset", "/privacy"]) {
    assert.equal(pageAccess(page), "public", page);
  }
  assert.equal(pageAccess("/office/refunds"), "refunds.view");
  assert.equal(pageAccess("/office/products/"), "catalog.manage");
  assert.equal(pageAccess("/account/orders/ord_001"), "user");
  assert.equal(pageAccess("/some-new-page"), "user");
  assert.equal(PUBLIC_PAGES.length, 8, "only the privacy notice was added to the public pages");
  assert.equal(pageAccess("/account/privacy"), "user", "consent decisions need a signed-in account");
  assert.ok(PROTECTED_PAGES.every((page) => pageAccess(page.path) === page.access));
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name) ? [full] : [];
  });
}

test("authorization is centralized: no module outside policy.ts compares roles", () => {
  const root = path.join(process.cwd(), "src");
  const offenders = sourceFiles(root)
    .filter((file) => !file.endsWith(path.join("lib", "policy.ts")))
    .filter((file) => /\brole\s*[!=]==?\s*["']|["']\s*[!=]==?\s*\w*\.?role\b|role\s*\)\s*\.includes|ROLES\.includes/.test(readFileSync(file, "utf8")))
    .map((file) => path.relative(root, file));
  assert.deepEqual(offenders, []);
});

test("no password, secret key or token is hard-coded in application code", () => {
  const root = path.join(process.cwd(), "src");
  const patterns = [/Retail123!/, /DEMO_PASSWORD/, /sk_(live|test)_[A-Za-z0-9]{8,}/, /whsec_[A-Za-z0-9]{8,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /eyJhbGciOi[A-Za-z0-9_-]{20,}/, /(password|secret|apiKey|token)\s*[:=]\s*["'][^"'\s]{8,}["']/i];
  // The only allowed match is the marker for accounts without a password, which is not a secret.
  const allowed = /UNUSABLE_PASSWORD = "!unusable"/;
  const offenders = sourceFiles(root)
    .filter((file) => !file.includes(`${path.sep}test${path.sep}`))
    .flatMap((file) =>
      readFileSync(file, "utf8")
        .split(/\r?\n/)
        .filter((line) => !allowed.test(line))
        .flatMap((line) => patterns.filter((pattern) => pattern.test(line)).map((pattern) => `${path.relative(root, file)} ${pattern}`)),
    );
  assert.deepEqual(offenders, []);
});
