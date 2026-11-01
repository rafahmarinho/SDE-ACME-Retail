import { createHash } from "node:crypto";

/**
 * Key management (SD Elements T60). Every cryptographic key or secret the application uses is
 * declared once here with its single purpose, how it is generated, where it is stored, how often it
 * rotates and how it is revoked. keyHealth() checks the deployed values at start-up without ever
 * logging them: format and length, no value reused for two purposes, rotation age (from the
 * optional <VARIABLE>_CREATED_AT date) and the keys production requires.
 *
 * ACME_DATA_KEYS holds one or more data keys as "id:base64,id:base64": the first one encrypts, the
 * others only decrypt, so a new key can be introduced and the old one retired after the data was
 * rewritten (src/lib/data-crypto.ts).
 */
type Env = Record<string, string | undefined>;

export interface KeyDefinition {
  env: string;
  purpose: string;
  generation: string;
  storage: string;
  rotationDays: number;
  rotation: string;
  revocation: string;
  requiredInProduction: boolean;
  valid: (value: string) => boolean;
}

const SECRET_STORE = "Hosting provider secret store (encrypted environment variable, server-side only); never in the repository, the database or logs.";

export const KEY_REGISTRY: readonly KeyDefinition[] = [
  {
    env: "ACME_DATA_KEYS",
    purpose: "Encrypts the data snapshot and stored return photos (AES-256-GCM).",
    generation: "32 random bytes from a CSPRNG, base64-encoded (for example: openssl rand -base64 32), with a new key id.",
    storage: SECRET_STORE,
    rotationDays: 180,
    rotation: "Put the new id first (k2:...,k1:...); every write re-encrypts with it; remove the old id once the data was rewritten.",
    revocation: "Re-encrypt with a new key, then remove the compromised id; data sealed only with it can no longer be opened.",
    requiredInProduction: true,
    valid: (value) => parseDataKeys(value).length > 0,
  },
  {
    env: "ACME_AUDIT_KEY",
    purpose: "Keys the HMAC chain of the audit trail, so the trail cannot be rewritten without it.",
    generation: "32 random bytes from a CSPRNG, base64-encoded (for example: openssl rand -base64 32).",
    storage: SECRET_STORE,
    rotationDays: 365,
    rotation: "Export or archive the trail, verify it, then set the new key; new events chain from the archive point.",
    revocation: "Replace the key and record the change in the incident log; verify the archived trail with the old key offline.",
    requiredInProduction: false,
    valid: (value) => Buffer.from(value, "base64").length === 32,
  },
  {
    env: "SUPABASE_SERVICE_ROLE_KEY",
    purpose: "Server access to the Supabase database and storage after the API has authorized the caller.",
    generation: "Issued by Supabase (project API settings).",
    storage: SECRET_STORE,
    rotationDays: 90,
    rotation: "Roll the key in Supabase, update the variable and redeploy.",
    revocation: "Roll the key in Supabase; the previous one stops working at once.",
    requiredInProduction: false,
    valid: (value) => value.length >= 30,
  },
  {
    env: "STRIPE_SECRET_KEY",
    purpose: "Creates Stripe Checkout sessions (test mode only).",
    generation: "Issued by Stripe (restricted test key).",
    storage: SECRET_STORE,
    rotationDays: 90,
    rotation: "Roll the key in Stripe with an expiry for the old one, update the variable and redeploy.",
    revocation: "Expire the key in the Stripe dashboard.",
    requiredInProduction: false,
    valid: (value) => /^sk_test_[A-Za-z0-9]{10,}$/.test(value),
  },
  {
    env: "STRIPE_WEBHOOK_SECRET",
    purpose: "Verifies the signature of Stripe webhook events.",
    generation: "Issued by Stripe for the webhook endpoint.",
    storage: SECRET_STORE,
    rotationDays: 180,
    rotation: "Roll the endpoint secret in Stripe and keep the old value in STRIPE_WEBHOOK_SECRET_PREVIOUS until it expires.",
    revocation: "Roll the endpoint secret and clear STRIPE_WEBHOOK_SECRET_PREVIOUS.",
    requiredInProduction: false,
    valid: (value) => /^whsec_[A-Za-z0-9]{10,}$/.test(value),
  },
  {
    env: "STRIPE_WEBHOOK_SECRET_PREVIOUS",
    purpose: "Previous webhook secret, accepted only while a rotation is in progress.",
    generation: "The value STRIPE_WEBHOOK_SECRET had before the rotation.",
    storage: SECRET_STORE,
    rotationDays: 7,
    rotation: "Clear it once Stripe stops signing with the old secret.",
    revocation: "Clear the variable.",
    requiredInProduction: false,
    valid: (value) => /^whsec_[A-Za-z0-9]{10,}$/.test(value),
  },
  {
    env: "MAIL_WEBHOOK_TOKEN",
    purpose: "Authenticates the application to the e-mail delivery provider.",
    generation: "Issued by the e-mail provider, or 32 random bytes from a CSPRNG.",
    storage: SECRET_STORE,
    rotationDays: 90,
    rotation: "Create a new token at the provider, update the variable, redeploy, then delete the old token.",
    revocation: "Delete the token at the provider.",
    requiredInProduction: false,
    valid: (value) => value.length >= 20,
  },
];

/** Parses ACME_DATA_KEYS ("id:base64,..." or a single base64 key, id "k1"); only 256-bit keys are kept. */
export function parseDataKeys(raw: string | undefined): { id: string; key: Buffer }[] {
  if (!raw) return [];
  const keys: { id: string; key: Buffer }[] = [];
  for (const part of raw.split(",").map((item) => item.trim()).filter(Boolean)) {
    const index = part.indexOf(":");
    const id = index > 0 ? part.slice(0, index) : "k1";
    const encoded = index > 0 ? part.slice(index + 1) : part;
    const key = Buffer.from(encoded, "base64");
    if (!/^[A-Za-z0-9_-]{1,20}$/.test(id) || key.length !== 32 || keys.some((item) => item.id === id)) return [];
    keys.push({ id, key });
  }
  return keys;
}

export function dataKeys(env: Env = process.env) {
  return parseDataKeys(env.ACME_DATA_KEYS);
}

function fingerprint(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

/** Findings about the deployed keys (never their values). Empty means healthy. */
export function keyHealth(env: Env = process.env, now = Date.now()): string[] {
  const findings: string[] = [];
  const production = env.NODE_ENV === "production";
  const seen = new Map<string, string>();
  for (const definition of KEY_REGISTRY) {
    const value = env[definition.env];
    if (!value) {
      if (production && definition.requiredInProduction) findings.push(`${definition.env}: missing (required in production)`);
      continue;
    }
    if (!definition.valid(value)) findings.push(`${definition.env}: invalid format or length`);
    const parts = definition.env === "ACME_DATA_KEYS" ? parseDataKeys(value).map((item) => item.key.toString("base64")) : [value];
    for (const part of parts) {
      const print = fingerprint(part);
      const other = seen.get(print);
      if (other) findings.push(`${definition.env}: same value as ${other} (a key must have a single purpose)`);
      else seen.set(print, definition.env);
    }
    const created = env[`${definition.env}_CREATED_AT`];
    if (created && Number.isFinite(Date.parse(created)) && now - Date.parse(created) > definition.rotationDays * 86_400_000) {
      findings.push(`${definition.env}: rotation due (older than ${definition.rotationDays} days)`);
    }
  }
  return findings;
}
