/**
 * Security configuration as code.
 *
 * Every setting that affects security is declared once in SETTINGS with its purpose, allowed
 * options, secure default, security relevance, operational impact and related settings.
 * `securityConfig()` reads the environment, validates each value against its allowed range and
 * keeps the secure default when a value is missing or out of range, so a deployment cannot weaken
 * a control below its floor by mistake. `describeSettings()` exposes the same documentation to
 * administrators and tests (see src/lib/config.test.ts).
 */

export type PasswordClass = "lower" | "upper" | "digit" | "symbol";
export type MailTransport = "memory" | "console" | "webhook" | "disabled";

export interface SecurityConfig {
  production: boolean;
  appOrigin: string | null;
  sessionMaxAgeMinutes: number;
  sessionIdleMinutes: number;
  lockoutThreshold: number;
  lockoutWindowMinutes: number;
  lockoutBaseMinutes: number;
  lockoutMaxMinutes: number;
  passwordMinLength: number;
  passwordMaxLength: number;
  passwordClasses: PasswordClass[];
  passwordHistory: number;
  passwordMaxAgeDays: number;
  passwordMinAgeHours: number;
  passwordBlocklist: string[];
  resetTokenMinutes: number;
  resetRequestsPerWindow: number;
  mailTransport: MailTransport;
  mailWebhookUrl: string | null;
  demoMode: boolean;
}

export interface SettingDoc {
  key: string;
  env: string;
  purpose: string;
  options: string;
  default: string;
  security: string;
  impact: string;
  related: string[];
}

type Env = Record<string, string | undefined>;

const warned = new Set<string>();

function warn(env: string, message: string) {
  if (warned.has(env)) return;
  warned.add(env);
  console.warn(JSON.stringify({ channel: "security", type: "config.rejected", outcome: "blocked", setting: env, detail: message }));
}

function intSetting(env: Env, name: string, fallback: number, min: number, max: number, allowZero = false): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (Number.isInteger(value) && ((allowZero && value === 0) || (value >= min && value <= max))) return value;
  warn(name, `Out of range (${allowZero ? "0 or " : ""}${min}-${max}); the secure default ${fallback} is used.`);
  return fallback;
}

function originSetting(env: Env, name: string): string | null {
  const raw = env[name];
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol === "https:" || (url.protocol === "http:" && local)) return url.origin;
  } catch {
    // fall through
  }
  warn(name, "Must be an absolute https origin (http is accepted only for localhost).");
  return null;
}

const ALL_CLASSES: PasswordClass[] = ["lower", "upper", "digit", "symbol"];

function classesSetting(env: Env): PasswordClass[] {
  const raw = env.PASSWORD_REQUIRE_CLASSES;
  if (!raw) return [...ALL_CLASSES];
  const parts = [...new Set(raw.split(",").map((item) => item.trim().toLowerCase()))];
  const valid = parts.every((item): item is PasswordClass => (ALL_CLASSES as string[]).includes(item));
  if (valid && parts.length >= 3) return parts as PasswordClass[];
  warn("PASSWORD_REQUIRE_CLASSES", "Use at least three of lower, upper, digit, symbol.");
  return [...ALL_CLASSES];
}

function mailSetting(env: Env, production: boolean): { transport: MailTransport; url: string | null } {
  const url = env.MAIL_WEBHOOK_URL ? originSafeUrl(env.MAIL_WEBHOOK_URL) : null;
  if (env.MAIL_WEBHOOK_URL && !url) warn("MAIL_WEBHOOK_URL", "Must be an https URL.");
  const requested = (env.MAIL_TRANSPORT ?? "").toLowerCase();
  if (requested === "webhook" || (!requested && url)) {
    if (url) return { transport: "webhook", url };
    return { transport: "disabled", url: null };
  }
  if (requested === "console") {
    if (!production) return { transport: "console", url: null };
    warn("MAIL_TRANSPORT", "The console transport is refused in production.");
    return { transport: "disabled", url: null };
  }
  if (requested === "disabled") return { transport: "disabled", url: null };
  return { transport: production ? "disabled" : "memory", url: null };
}

function originSafeUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function securityConfig(env: Env = process.env): SecurityConfig {
  const production = env.NODE_ENV === "production";
  const mail = mailSetting(env, production);
  const demoRaw = env.ACME_DEMO_MODE;
  return {
    production,
    appOrigin: originSetting(env, "APP_ORIGIN"),
    sessionMaxAgeMinutes: intSetting(env, "SESSION_MAX_AGE_MINUTES", 720, 15, 1440),
    sessionIdleMinutes: intSetting(env, "SESSION_IDLE_MINUTES", 30, 5, 60),
    lockoutThreshold: intSetting(env, "AUTH_LOCKOUT_THRESHOLD", 5, 3, 10),
    lockoutWindowMinutes: intSetting(env, "AUTH_LOCKOUT_WINDOW_MINUTES", 15, 5, 1440),
    lockoutBaseMinutes: intSetting(env, "AUTH_LOCKOUT_BASE_MINUTES", 15, 1, 60),
    lockoutMaxMinutes: intSetting(env, "AUTH_LOCKOUT_MAX_MINUTES", 1440, 15, 10080),
    passwordMinLength: intSetting(env, "PASSWORD_MIN_LENGTH", 12, 12, 64),
    passwordMaxLength: 128,
    passwordClasses: classesSetting(env),
    passwordHistory: intSetting(env, "PASSWORD_HISTORY", 3, 3, 24),
    passwordMaxAgeDays: intSetting(env, "PASSWORD_MAX_AGE_DAYS", 0, 30, 365, true),
    passwordMinAgeHours: intSetting(env, "PASSWORD_MIN_AGE_HOURS", 0, 1, 72, true),
    passwordBlocklist: (env.PASSWORD_BLOCKLIST ?? "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length >= 4 && item.length <= 64)
      .slice(0, 500),
    resetTokenMinutes: intSetting(env, "RESET_TOKEN_MINUTES", 30, 10, 60),
    resetRequestsPerWindow: intSetting(env, "RESET_REQUESTS_PER_WINDOW", 3, 1, 5),
    mailTransport: mail.transport,
    mailWebhookUrl: mail.url,
    demoMode: demoRaw === undefined || demoRaw === "" ? !production : demoRaw === "enabled",
  };
}

export const SETTINGS: SettingDoc[] = [
  { key: "appOrigin", env: "APP_ORIGIN", purpose: "Canonical origin used for links in e-mail, Stripe return URLs and the same-origin check.", options: "Absolute https origin; http only for localhost.", default: "Unset: the Host header is compared and e-mail links are relative.", security: "Avoids trusting the Host header for redirects and links.", impact: "Wrong value blocks every mutation (403) and breaks Stripe returns.", related: ["mailTransport"] },
  { key: "sessionMaxAgeMinutes", env: "SESSION_MAX_AGE_MINUTES", purpose: "Absolute session lifetime.", options: "15-1440 minutes.", default: "720", security: "Limits the use of a stolen session token.", impact: "Shorter values sign users out more often.", related: ["sessionIdleMinutes"] },
  { key: "sessionIdleMinutes", env: "SESSION_IDLE_MINUTES", purpose: "Idle timeout; passive polling does not extend it.", options: "5-60 minutes.", default: "30", security: "Protects unattended sessions.", impact: "Shorter values sign idle users out sooner.", related: ["sessionMaxAgeMinutes"] },
  { key: "lockoutThreshold", env: "AUTH_LOCKOUT_THRESHOLD", purpose: "Failed logins inside the window that lock an account.", options: "3-10.", default: "5", security: "Stops password guessing on one account.", impact: "Lower values lock legitimate users sooner.", related: ["lockoutWindowMinutes", "lockoutBaseMinutes"] },
  { key: "lockoutWindowMinutes", env: "AUTH_LOCKOUT_WINDOW_MINUTES", purpose: "Period in which failures are counted.", options: "5-1440 minutes.", default: "15", security: "Defines the predetermined period for the attempt limit.", impact: "Longer windows count more failures.", related: ["lockoutThreshold"] },
  { key: "lockoutBaseMinutes", env: "AUTH_LOCKOUT_BASE_MINUTES", purpose: "First lock duration; doubles on each further lockout.", options: "1-60 minutes.", default: "15", security: "Exponential back-off makes brute force impractical.", impact: "Locked users wait longer.", related: ["lockoutMaxMinutes"] },
  { key: "lockoutMaxMinutes", env: "AUTH_LOCKOUT_MAX_MINUTES", purpose: "Cap for the exponential lock duration.", options: "15-10080 minutes.", default: "1440", security: "Bounds the back-off at 24 h.", impact: "Higher caps increase lockout-based denial of service.", related: ["lockoutBaseMinutes"] },
  { key: "passwordMinLength", env: "PASSWORD_MIN_LENGTH", purpose: "Minimum password length.", options: "12-64.", default: "12", security: "Resists guessing.", impact: "Longer minimums are harder to remember.", related: ["passwordClasses"] },
  { key: "passwordMaxLength", env: "(fixed)", purpose: "Maximum password length.", options: "128 (fixed).", default: "128", security: "Allows passphrases without KDF denial of service.", impact: "None.", related: ["passwordMinLength"] },
  { key: "passwordClasses", env: "PASSWORD_REQUIRE_CLASSES", purpose: "Character classes a password must contain.", options: "At least three of lower, upper, digit, symbol.", default: "lower,upper,digit,symbol", security: "Complexity floor.", impact: "More classes are harder to remember.", related: ["passwordMinLength"] },
  { key: "passwordHistory", env: "PASSWORD_HISTORY", purpose: "Previous passwords that cannot be reused.", options: "3-24.", default: "3", security: "Prevents reuse of old, possibly exposed passwords.", impact: "Each change verifies this many hashes (about 0.5 s each).", related: ["passwordMinAgeHours"] },
  { key: "passwordMaxAgeDays", env: "PASSWORD_MAX_AGE_DAYS", purpose: "Maximum password age before a forced change.", options: "0 (off) or 30-365 days.", default: "0 (NIST SP 800-63B advises against periodic expiry)", security: "Optional expiry when a regulation requires it.", impact: "Users must change the password at the next sign-in.", related: ["passwordMinAgeHours"] },
  { key: "passwordMinAgeHours", env: "PASSWORD_MIN_AGE_HOURS", purpose: "Minimum time between voluntary password changes.", options: "0 (off) or 1-72 hours.", default: "0", security: "Stops cycling through the history.", impact: "Users cannot change twice in a row.", related: ["passwordHistory"] },
  { key: "passwordBlocklist", env: "PASSWORD_BLOCKLIST", purpose: "Extra words that cannot be used in passwords, added to the built-in list.", options: "Comma-separated words, 4-64 characters, up to 500.", default: "Built-in list only", security: "Blocks organization-specific dictionary words.", impact: "None.", related: ["passwordMinLength"] },
  { key: "resetTokenMinutes", env: "RESET_TOKEN_MINUTES", purpose: "Lifetime of a password-reset link.", options: "10-60 minutes.", default: "30", security: "Limits the exposure of a mailed link.", impact: "Shorter values expire links sooner.", related: ["resetRequestsPerWindow"] },
  { key: "resetRequestsPerWindow", env: "RESET_REQUESTS_PER_WINDOW", purpose: "Reset links one account can receive per 15 minutes.", options: "1-5.", default: "3", security: "Per-account anti-automation for recovery.", impact: "Extra requests are silently ignored.", related: ["resetTokenMinutes"] },
  { key: "mailTransport", env: "MAIL_TRANSPORT / MAIL_WEBHOOK_URL / MAIL_WEBHOOK_TOKEN", purpose: "How e-mail is delivered to the registered address.", options: "webhook (https provider), console (development only), memory (tests), disabled.", default: "memory outside production; disabled in production unless MAIL_WEBHOOK_URL is set", security: "Reset links go only to the account's mailbox and are never stored or returned by the API.", impact: "Without a transport in production no reset e-mail is sent.", related: ["appOrigin"] },
  { key: "mailWebhookUrl", env: "MAIL_WEBHOOK_URL", purpose: "HTTPS endpoint of the e-mail provider used by the webhook transport.", options: "Absolute https URL; MAIL_WEBHOOK_TOKEN is sent as a bearer token.", default: "Unset", security: "Mail leaves the application only over TLS to the configured provider.", impact: "Wrong value means reset and notification e-mails are not delivered (logged).", related: ["mailTransport"] },
  { key: "demoMode", env: "ACME_DEMO_MODE", purpose: "Enables the demo-only features: customers pick the simulated payment outcome, administrators change scenarios, advance shipments and reset data.", options: "enabled or disabled.", default: "enabled outside production, disabled in production", security: "Test and simulation features stay off in a release unless explicitly enabled.", impact: "When disabled the default payment scenario applies and the simulation tools answer 403.", related: [] },
  { key: "seedPassword", env: "ACME_SEED_PASSWORD", purpose: "Initial password of the seeded demo accounts, set per deployment.", options: "Any value that passes the password policy.", default: "Unset: seeded accounts have no usable password", security: "No password is hard-coded; every seeded account must change it at first sign-in.", impact: "Without it nobody can sign in to the seeded accounts.", related: ["passwordMinLength"] },
  { key: "requestBodyLimits", env: "(fixed, src/lib/http.ts LIMITS)", purpose: "Maximum request body per route type, checked before parsing.", options: "JSON 16 KB, upload 2.5 MB, webhook 64 KB, CSP report 8 KB.", default: "As listed", security: "Prevents memory exhaustion from oversized messages.", impact: "Larger bodies get HTTP 413.", related: [] },
  { key: "rateLimits", env: "(fixed, src/app/api/[[...path]]/route.ts)", purpose: "Requests per client IP and per account in a 15-minute window, per endpoint bucket.", options: "Per bucket; reads 300, mutations 30, sign-in 10, recovery 5.", default: "As listed", security: "Throttles brute force and scraping.", impact: "Extra requests get HTTP 429.", related: ["lockoutThreshold"] },
];

export function describeSettings(): SettingDoc[] {
  return SETTINGS.map((item) => ({ ...item, related: [...item.related] }));
}
