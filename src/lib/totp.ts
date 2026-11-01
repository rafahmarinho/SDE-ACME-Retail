import { createHmac, randomBytes } from "node:crypto";
import { safeEqual } from "./security";

/**
 * Time-based one-time passwords (RFC 6238 over RFC 4226 HOTP) for the second authentication
 * factor. Compatible with standard authenticator apps: 160-bit random secret shown in base32,
 * HMAC-SHA1, 30-second steps, 6 digits. Verification accepts one step of clock drift either way
 * and returns the time step used, so the caller can refuse a code that was already used.
 */
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error("Invalid base32 character.");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

export function createTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** HOTP value for one counter (RFC 4226 dynamic truncation). */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function totpCounter(timeMs: number): number {
  return Math.floor(timeMs / 1000 / TOTP_STEP_SECONDS);
}

export function totpCode(secretBase32: string, timeMs = Date.now()): string {
  return hotp(base32Decode(secretBase32), totpCounter(timeMs));
}

/** Returns the matching time step (current, previous or next) or null. Constant-time comparison. */
export function verifyTotp(secretBase32: string, code: string, timeMs = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretBase32);
  const current = totpCounter(timeMs);
  let matched: number | null = null;
  for (const counter of [current - 1, current, current + 1]) {
    if (safeEqual(hotp(secret, counter), code)) matched = counter;
  }
  return matched;
}

/** otpauth:// URI that authenticator apps import (also typed in by hand from the base32 secret). */
export function otpauthUri(secretBase32: string, account: string, issuer = "ACME Retail"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}
