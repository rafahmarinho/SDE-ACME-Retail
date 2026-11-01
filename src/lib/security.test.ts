import assert from "node:assert/strict";
import test from "node:test";
import { scryptSync, randomBytes } from "node:crypto";
import {
  assertSameOrigin,
  detectImageType,
  hashSecret,
  isAllowedImage,
  needsRehash,
  passwordIssues,
  sanitizeText,
  SCRYPT_PARAMS,
  UNUSABLE_PASSWORD,
  verifySecret,
} from "./security";
import { safeNextPath } from "./redirect";
import { AppError } from "./errors";
import { toErrorResponse } from "./errors";
import { captureLogs, testPassword } from "../test/support";

test("passwords are hashed with versioned scrypt parameters at the OWASP minimum", async () => {
  assert.deepEqual([SCRYPT_PARAMS.ln, SCRYPT_PARAMS.r, SCRYPT_PARAMS.p], [17, 8, 1]);
  const secret = testPassword();
  const hash = await hashSecret(secret);
  assert.match(hash, /^scrypt\$ln=17,r=8,p=1\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
  assert.equal(await verifySecret(secret, hash), true);
  assert.equal(await verifySecret(`${secret}x`, hash), false);
  assert.equal(needsRehash(hash), false);
  assert.notEqual(await hashSecret(secret), hash, "a fresh random salt is used for every hash");
});

test("legacy hashes still verify and are flagged for rehash; unusable markers never verify", async () => {
  const salt = randomBytes(16).toString("hex");
  const legacy = `scrypt$${salt}$${scryptSync("Legacy-Pass-81!", salt, 32).toString("hex")}`;
  assert.equal(await verifySecret("Legacy-Pass-81!", legacy), true);
  assert.equal(needsRehash(legacy), true);
  assert.equal(await verifySecret("anything", UNUSABLE_PASSWORD), false);
  assert.equal(await verifySecret("anything", "scrypt$ln=99,r=8,p=1$aa$bb"), false);
});

test("password policy enforces length, classes, blocklist, sequences and context words", () => {
  assert.deepEqual(passwordIssues(testPassword()), []);
  assert.ok(passwordIssues("Short-1a!").includes("Use at least 12 characters."));
  assert.ok(passwordIssues("Retail123!").length > 0, "the old demo password is rejected");
  assert.ok(passwordIssues("P@ssw0rd2024!").includes("Avoid common passwords and dictionary words."));
  assert.ok(passwordIssues("Welcome!!2025").includes("Avoid common passwords and dictionary words."));
  assert.ok(passwordIssues("Qx-1234-Brwq!").includes("Avoid repeated or sequential characters."));
  assert.ok(passwordIssues("Zaaaa-Qmw-81!").includes("Avoid repeated or sequential characters."));
  assert.ok(passwordIssues("Avery-Qmzw-81!", { email: "avery.chen@example.test", name: "Avery Chen" }).includes("Do not use your name, e-mail or the store name."));
  assert.ok(passwordIssues("nouppercase-81!x").includes("Include an uppercase letter."));
  assert.ok(passwordIssues("x".repeat(129)).includes("Use at most 128 characters."));
});

test("sanitizeText removes control, bidi and zero-width characters and truncates", () => {
  assert.equal(sanitizeText("a\u0000b\u202Ec\u200Bd\u0085e  ", 10), "abcde");
  assert.equal(sanitizeText("x".repeat(50), 10).length, 10);
});

test("image validation cross-checks magic bytes with the extension", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1]);
  assert.equal(detectImageType(png), "png");
  assert.equal(isAllowedImage(png, "photo.png"), true);
  assert.equal(isAllowedImage(png, "photo.jpg"), false, "extension must match the detected type");
  assert.equal(isAllowedImage(new TextEncoder().encode("<script>alert(1)</script>"), "x.png"), false);
});

test("open redirect: only internal paths of known pages are accepted after login", () => {
  assert.equal(safeNextPath("/checkout", "/account"), "/checkout");
  assert.equal(safeNextPath("/account/orders/ord_001?x=1", "/account"), "/account/orders/ord_001?x=1");
  for (const hostile of ["https://evil.example", "//evil.example/x", "/\\evil.example", "\\\\evil.example", "javascript:alert(1)", "/%0d%0aLocation:x", " /checkout", "/unknown-page", "http:/evil.example"]) {
    assert.equal(safeNextPath(hostile, "/account"), "/account", hostile);
  }
  assert.equal(safeNextPath(null, "/office"), "/office");
});

test("same-origin check requires a matching Origin and rejects cross-site fetch metadata with 403", () => {
  const request = (headers: Record<string, string>) => new Request("http://localhost/api/cart", { method: "POST", headers: { host: "localhost", ...headers } });
  assert.doesNotThrow(() => assertSameOrigin(request({ origin: "http://localhost", "sec-fetch-site": "same-origin" }), null));
  const forged: Record<string, string>[] = [{}, { origin: "https://evil.example" }, { origin: "http://localhost", "sec-fetch-site": "cross-site" }, { origin: "http://localhost", "sec-fetch-site": "same-site" }, { origin: "null" }];
  for (const headers of forged) {
    assert.throws(() => assertSameOrigin(request(headers), null), (error: unknown) => error instanceof AppError && error.status === 403);
  }
  assert.throws(() => assertSameOrigin(request({ origin: "http://localhost" }), "https://shop.example"), AppError);
});

test("unexpected errors return a generic message with a correlation id that is logged", () => {
  const logs = captureLogs();
  const mapped = toErrorResponse(new Error("ENOENT: open C:\\srv\\secret\\db.json"), { method: "GET", path: "/api/x" });
  assert.equal(mapped.status, 500);
  assert.equal(mapped.body.error, "Something went wrong. Please try again.");
  assert.match(mapped.body.errorId ?? "", /^[0-9a-f-]{36}$/);
  assert.ok(!JSON.stringify(mapped.body).includes("secret"));
  const entry = logs.find((item) => item.errorId === mapped.body.errorId);
  assert.ok(entry && entry.channel === "app" && entry.detail?.includes("ENOENT"));
  const expected = toErrorResponse(new AppError("Order not found.", 404, "not_found"));
  assert.deepEqual(expected, { status: 404, body: { error: "Order not found.", code: "not_found" } });
});
