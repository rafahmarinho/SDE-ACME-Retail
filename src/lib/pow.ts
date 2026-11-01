import { createHash } from "node:crypto";

/**
 * Anti-automation for the password reset page (SD Elements T2): a proof-of-work challenge instead
 * of an image CAPTCHA, so it needs no third-party service and nothing to see or hear (accessible).
 * The server issues a random salt; the browser must find a nonce such that
 * SHA-256(salt + ":" + nonce) starts with POW_DIFFICULTY zero bits (about a second of work for one
 * request, a large cost for bulk automation). Each challenge expires and works only once.
 */
export const POW_DIFFICULTY = 16;
export const CHALLENGE_MINUTES = 5;

export function leadingZeroBits(digest: Uint8Array): number {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

export function powDigest(salt: string, nonce: string): Buffer {
  return createHash("sha256").update(`${salt}:${nonce}`).digest();
}

export function verifyPow(salt: string, nonce: string, difficulty: number): boolean {
  return /^\d{1,12}$/.test(nonce) && leadingZeroBits(powDigest(salt, nonce)) >= difficulty;
}
