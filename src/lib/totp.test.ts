import assert from "node:assert/strict";
import test from "node:test";
import { base32Decode, base32Encode, createTotpSecret, hotp, otpauthUri, totpCode, totpCounter, verifyTotp } from "./totp";

// RFC 6238 appendix B test secret (SHA-1): ASCII "12345678901234567890".
const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");

test("TOTP matches the RFC 6238 SHA-1 test vectors", () => {
  const vectors: [number, string][] = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];
  for (const [seconds, expected] of vectors) {
    assert.equal(hotp(RFC_SECRET, totpCounter(seconds * 1000), 8), expected, `T=${seconds}`);
  }
});

test("base32 round-trips and secrets carry 160 random bits", () => {
  assert.equal(base32Encode(RFC_SECRET), "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.deepEqual(base32Decode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq"), RFC_SECRET);
  const secret = createTotpSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.notEqual(createTotpSecret(), secret);
  assert.match(otpauthUri(secret, "avery@example.test"), /^otpauth:\/\/totp\/ACME%20Retail%3Aavery%40example\.test\?secret=[A-Z2-7]{32}&issuer=ACME%20Retail&algorithm=SHA1&digits=6&period=30$/);
});

test("verification allows one step of clock drift and nothing more", () => {
  const secret = createTotpSecret();
  const now = Date.now();
  const step = totpCounter(now);
  assert.equal(verifyTotp(secret, totpCode(secret, now), now), step);
  assert.equal(verifyTotp(secret, totpCode(secret, now - 30_000), now), step - 1);
  assert.equal(verifyTotp(secret, totpCode(secret, now + 30_000), now), step + 1);
  assert.equal(verifyTotp(secret, totpCode(secret, now - 90_000), now), null);
  assert.equal(verifyTotp(secret, "12345", now), null, "malformed codes are refused");
  assert.equal(verifyTotp(secret, "abcdef", now), null);
});
