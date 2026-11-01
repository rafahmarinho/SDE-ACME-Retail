import assert from "node:assert/strict";
import test from "node:test";
import { NextResponse } from "next/server";
import { checkResponse, enforceResponseContract, orderDto, RESPONSE_SCHEMAS, undeclaredResponses } from "./api-contract";
import { API_ROUTES, matchApiRoute } from "./policy";
import { buildSeed } from "./seed";
import { captureLogs, testPassword } from "../test/support";

process.env.ACME_SEED_PASSWORD = testPassword();
const logs = captureLogs();
const route = (method: string, path: string) => matchApiRoute(method, path.split("/"))!;
const user = { id: "usr_01", email: "customer@acme-retail.test", fullName: "Avery Chen", role: "customer", phone: "", mustChangePassword: false, mfaEnabled: false };

test("every declared API route has a response schema, and no schema exists for an undeclared route", () => {
  assert.deepEqual(undeclaredResponses(), []);
  const declared = new Set(API_ROUTES.map((item) => `${item.method} ${item.path}`));
  assert.deepEqual(Object.keys(RESPONSE_SCHEMAS).filter((key) => !declared.has(key)), []);
});

test("responses with undeclared fields, wrong types or missing fields fail validation", () => {
  const session = route("GET", "session");
  const valid = { user, permissions: ["orders.purchase"], stripe: false, csrfToken: "abc.def" };
  assert.deepEqual(checkResponse(session, 200, valid), { ok: true });
  assert.equal(checkResponse(session, 200, { ...valid, user: { ...user, passwordHash: "scrypt$..." } }).ok, false, "an extra field is refused");
  assert.equal(checkResponse(session, 200, { ...valid, stripe: "no" }).ok, false, "a wrong type is refused");
  const { csrfToken: _omitted, ...missing } = valid;
  void _omitted;
  assert.equal(checkResponse(session, 200, missing).ok, false, "a missing field is refused");
  assert.equal(checkResponse(route("POST", "csp-report"), 204, null).ok, true);
  assert.equal(checkResponse(route("POST", "csp-report"), 204, { leaked: true }).ok, false);
});

test("errors have one schema: message, optional code and error id, nothing else", () => {
  const orders = route("GET", "orders");
  assert.equal(checkResponse(orders, 404, { error: "Order not found.", code: "not_found" }).ok, true);
  assert.equal(checkResponse(orders, 500, { error: "Something went wrong. Please try again.", errorId: "e1" }).ok, true);
  assert.equal(checkResponse(orders, 500, { error: "boom", stack: "at C:\\srv\\app.js" }).ok, false, "stack traces never leave");
  assert.equal(checkResponse(null, 404, { error: "Not found." }).ok, true);
});

test("order DTOs never carry the owner id or the simulated payment scenario", async () => {
  const order = (await buildSeed()).orders[0];
  const dto = orderDto(order);
  assert.equal("userId" in dto, false);
  assert.equal("paymentScenario" in dto, false);
  assert.equal(checkResponse(route("POST", "orders/x/cancel"), 200, dto).ok, true);
  assert.equal(checkResponse(route("POST", "orders/x/cancel"), 200, order).ok, false, "the raw record does not satisfy the contract");
});

test("a response that breaks its contract is replaced by a generic 500 and logged", async () => {
  const request = new Request("http://localhost/api/session");
  const leaking = NextResponse.json({ user: { ...user, passwordHash: "x" }, permissions: [], stripe: false, csrfToken: "a.b" });
  const blocked = await enforceResponseContract(request, route("GET", "session"), leaking);
  assert.equal(blocked.status, 500);
  const body = (await blocked.json()) as { error: string; errorId: string };
  assert.equal(body.error, "Something went wrong. Please try again.");
  assert.ok(!JSON.stringify(body).includes("passwordHash"));
  assert.ok(logs.some((entry) => entry.type === "response.schema_violation" && entry.detail?.includes("GET session")));
  const fine = NextResponse.json({ user: null, permissions: [], stripe: false, csrfToken: "a.b" });
  assert.equal((await enforceResponseContract(request, route("GET", "session"), fine)).status, 200);
});
