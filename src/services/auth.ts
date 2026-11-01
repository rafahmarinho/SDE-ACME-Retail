import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { AppError } from "../lib/errors";
import { updateStore, readStore } from "../lib/db/store";
import {
  hashSecret,
  needsRehash,
  passwordIssues,
  randomToken,
  sha256,
  timingDummyHash,
  UNUSABLE_PASSWORD,
  verifySecret,
  sanitizeText,
} from "../lib/security";
import { securityConfig, type SecurityConfig } from "../lib/config";
import { securityLog } from "../lib/security-log";
import { sendMail } from "../lib/mailer";
import { appendEvent } from "../lib/audit";
import { requiresSecondFactor } from "../lib/policy";
import { base32Encode, createTotpSecret, otpauthUri, verifyTotp } from "../lib/totp";
import { CHALLENGE_MINUTES, POW_DIFFICULTY, verifyPow } from "../lib/pow";
import { toPublicUser, type PublicUser, type Session, type StoreData, type User } from "../lib/types";

/** One message for unknown accounts, wrong passwords and locked accounts (no account enumeration). */
export const GENERIC_LOGIN_ERROR = "Email or password is incorrect.";
const RESET_WINDOW_MS = 15 * 60_000;

export interface RequestContext {
  ip?: string;
}

function iso(ms: number) {
  return new Date(ms).toISOString();
}

function authEvent(data: StoreData, type: string, message: string, actorId: string | null) {
  appendEvent(data, { type, message, orderId: null, actorId });
}

/** Random delay added to every failed authentication so failure timing carries no signal. */
function failureDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100 + randomInt(0, 200)));
}

function sessionExpired(session: Session, now: number, config: SecurityConfig) {
  return Date.parse(session.expiresAt) <= now || now - Date.parse(session.lastSeenAt) > config.sessionIdleMinutes * 60_000;
}

function linkOrigin(config: SecurityConfig) {
  return config.appOrigin ?? (config.production ? "" : "http://localhost:3000");
}

type LoginOutcome =
  | { ok: true; token: string; user: PublicUser; userId: string; rehash: boolean }
  | { ok: false; reason: "unknown_account" | "locked" | "locked_now" | "bad_password"; userId: string | null };

export async function login(email: string, password: string, context: RequestContext = {}): Promise<{ token: string; user: PublicUser }> {
  const config = securityConfig();
  const normalized = sanitizeText(email, 120).toLowerCase();
  const stored = await readStore((data) => data.users.find((item) => item.email === normalized)?.passwordHash ?? null);
  // The KDF always runs (a dummy hash for unknown accounts), so timing does not reveal accounts.
  const verified = await verifySecret(password, stored ?? (await timingDummyHash()));
  const now = Date.now();
  const outcome = await updateStore((data): LoginOutcome => {
    const user = data.users.find((item) => item.email === normalized);
    if (!user) {
      authEvent(data, "auth.failure", "Login failed for an unknown account.", null);
      return { ok: false, reason: "unknown_account", userId: null };
    }
    if (user.lockedUntil && Date.parse(user.lockedUntil) > now) {
      authEvent(data, "auth.failure", "Login attempt while the account is locked.", user.id);
      return { ok: false, reason: "locked", userId: user.id };
    }
    if (!verified || user.passwordHash !== stored) {
      const windowStart = now - config.lockoutWindowMinutes * 60_000;
      const recent = user.lastFailedAt && Date.parse(user.lastFailedAt) > windowStart;
      user.failedLogins = recent ? user.failedLogins + 1 : 1;
      user.lastFailedAt = iso(now);
      if (user.failedLogins >= config.lockoutThreshold) {
        user.lockouts = (user.lockouts ?? 0) + 1;
        const minutes = Math.min(config.lockoutBaseMinutes * 2 ** (user.lockouts - 1), config.lockoutMaxMinutes);
        user.lockedUntil = iso(now + minutes * 60_000);
        user.failedLogins = 0;
        authEvent(data, "auth.locked", `Account locked for ${minutes} minutes after ${config.lockoutThreshold} failed logins.`, user.id);
        return { ok: false, reason: "locked_now", userId: user.id };
      }
      authEvent(data, "auth.failure", "Login failed.", user.id);
      return { ok: false, reason: "bad_password", userId: user.id };
    }
    user.failedLogins = 0;
    user.lastFailedAt = null;
    user.lockouts = 0;
    user.lockedUntil = null;
    user.lastLoginAt = iso(now);
    if (config.passwordMaxAgeDays > 0) {
      const changed = user.passwordChangedAt ? Date.parse(user.passwordChangedAt) : 0;
      if (now - changed > config.passwordMaxAgeDays * 86_400_000) user.mustChangePassword = true;
    }
    data.sessions = data.sessions.filter((item) => item.userId !== user.id && !sessionExpired(item, now, config));
    const token = randomToken();
    data.sessions.push({
      id: randomUUID(),
      userId: user.id,
      tokenHash: sha256(token),
      createdAt: iso(now),
      expiresAt: iso(now + config.sessionMaxAgeMinutes * 60_000),
      lastSeenAt: iso(now),
      stepUpAt: null,
    });
    authEvent(data, "auth.success", "Login succeeded.", user.id);
    return { ok: true, token, user: toPublicUser(user), userId: user.id, rehash: needsRehash(user.passwordHash) };
  });
  if (!outcome.ok) {
    securityLog({
      type: outcome.reason === "locked_now" ? "auth.lockout" : "auth.login",
      outcome: "failure",
      actorId: outcome.userId,
      ip: context.ip,
      detail: outcome.reason,
    });
    await failureDelay();
    throw new AppError(GENERIC_LOGIN_ERROR, 401, "unauthorized");
  }
  securityLog({ type: "auth.login", outcome: "success", actorId: outcome.userId, ip: context.ip });
  if (outcome.rehash && stored) {
    const fresh = await hashSecret(password);
    await updateStore((data) => {
      const user = data.users.find((item) => item.id === outcome.userId);
      if (user && user.passwordHash === stored) user.passwordHash = fresh;
    });
  }
  return { token: outcome.token, user: outcome.user };
}

export async function logout(token: string, context: RequestContext = {}) {
  const tokenHash = sha256(token);
  const userId = await updateStore((data) => {
    const session = data.sessions.find((item) => item.tokenHash === tokenHash);
    data.sessions = data.sessions.filter((item) => item.tokenHash !== tokenHash);
    if (session) authEvent(data, "auth.logout", "Signed out.", session.userId);
    return session?.userId ?? null;
  });
  securityLog({ type: "auth.logout", outcome: userId ? "success" : "info", actorId: userId, ip: context.ip });
}

/**
 * Resolves a session token. Active requests slide the idle timeout; passive requests (background
 * polling, page checks) only read it, so an unattended tab still times out.
 */
export async function sessionUser(token: string | undefined, options: { touch?: boolean; ip?: string } = {}): Promise<PublicUser | null> {
  if (!token || token.length > 200) return null;
  const tokenHash = sha256(token);
  const config = securityConfig();
  const now = Date.now();
  if (options.touch === false) {
    return readStore((data) => {
      const session = data.sessions.find((item) => item.tokenHash === tokenHash);
      if (!session || sessionExpired(session, now, config)) return null;
      const user = data.users.find((item) => item.id === session.userId);
      return user ? toPublicUser(user) : null;
    });
  }
  const result = await updateStore((data) => {
    const session = data.sessions.find((item) => item.tokenHash === tokenHash);
    if (!session) return { user: null, state: "invalid" as const };
    if (sessionExpired(session, now, config)) {
      data.sessions = data.sessions.filter((item) => item.id !== session.id);
      return { user: null, state: "expired" as const };
    }
    const user = data.users.find((item) => item.id === session.userId);
    if (!user) return { user: null, state: "invalid" as const };
    session.lastSeenAt = iso(now);
    return { user: toPublicUser(user), state: "valid" as const };
  });
  if (result.state !== "valid") {
    securityLog({ type: `session.${result.state}`, outcome: "failure", ip: options.ip, detail: "A session cookie did not match an active session." });
  }
  return result.user;
}

function applyNewPassword(user: User, passwordHash: string, at: string, config: SecurityConfig) {
  user.passwordHistory = [user.passwordHash, ...(user.passwordHistory ?? [])]
    .filter((item) => item !== UNUSABLE_PASSWORD)
    .slice(0, config.passwordHistory);
  user.passwordHash = passwordHash;
  user.passwordChangedAt = at;
  user.mustChangePassword = false;
  user.failedLogins = 0;
  user.lastFailedAt = null;
  user.lockouts = 0;
  user.lockedUntil = null;
}

async function assertNotReused(password: string, hashes: string[]) {
  const matches = await Promise.all(hashes.filter((hash) => hash !== UNUSABLE_PASSWORD).map((hash) => verifySecret(password, hash)));
  if (matches.some(Boolean)) throw new AppError("Choose a password you have not used recently.");
}

function passwordChangedMail(to: string) {
  return sendMail({
    to,
    subject: "Your ACME Retail password was changed",
    text:
      "The password for your ACME Retail account was just changed and every signed-in session was ended. " +
      "If you did not make this change, reset your password now and contact support.",
  });
}

export async function requestReset(email: string, context: RequestContext = {}) {
  const config = securityConfig();
  const normalized = sanitizeText(email, 120).toLowerCase();
  const token = randomToken(24);
  const now = Date.now();
  const target = await updateStore((data) => {
    const user = data.users.find((item) => item.email === normalized);
    if (!user) {
      authEvent(data, "auth.reset_unknown", "Password reset requested for an unknown account.", null);
      return null;
    }
    const recent = data.resetTokens.filter((item) => item.userId === user.id && Date.parse(item.createdAt) > now - RESET_WINDOW_MS);
    if (recent.length >= config.resetRequestsPerWindow) {
      authEvent(data, "auth.reset_throttled", "Password reset ignored: too many requests for this account.", user.id);
      return null;
    }
    data.resetTokens = data.resetTokens.filter((item) => Date.parse(item.expiresAt) > now - 86_400_000);
    for (const item of data.resetTokens) {
      if (item.userId === user.id && !item.usedAt) item.usedAt = iso(now);
    }
    // Only the hash is stored; the link exists only in the e-mail sent to the registered address.
    data.resetTokens.push({
      id: randomUUID(),
      userId: user.id,
      tokenHash: sha256(token),
      createdAt: iso(now),
      expiresAt: iso(now + config.resetTokenMinutes * 60_000),
      usedAt: null,
    });
    authEvent(data, "auth.reset_requested", "Password reset requested.", user.id);
    return { email: user.email };
  });
  securityLog({ type: "auth.reset_requested", outcome: target ? "success" : "info", ip: context.ip });
  if (target) {
    await sendMail({
      to: target.email,
      subject: "Reset your ACME Retail password",
      text:
        `Use this one-time link within ${config.resetTokenMinutes} minutes to choose a new password: ` +
        `${linkOrigin(config)}/reset#token=${token}\n` +
        "If you did not ask for this, ignore this message. Your password has not been changed.",
    });
  }
}

export async function resetPassword(token: string, password: string, context: RequestContext = {}) {
  const config = securityConfig();
  const tokenHash = sha256(token);
  const now = Date.now();
  const valid = (data: StoreData) => data.resetTokens.find((item) => item.tokenHash === tokenHash && !item.usedAt && Date.parse(item.expiresAt) > now);
  const target = await readStore((data) => {
    const row = valid(data);
    const user = row && data.users.find((item) => item.id === row.userId);
    return user ? { email: user.email, name: user.fullName, hashes: [user.passwordHash, ...(user.passwordHistory ?? [])].slice(0, config.passwordHistory + 1) } : null;
  });
  if (!target) {
    securityLog({ type: "auth.password_reset", outcome: "failure", ip: context.ip, detail: "invalid_or_expired_token" });
    throw new AppError("This reset link is invalid or has expired.");
  }
  const issues = passwordIssues(password, { email: target.email, name: target.name }, config);
  if (issues.length) throw new AppError(issues[0]);
  await assertNotReused(password, target.hashes);
  const passwordHash = await hashSecret(password);
  const result = await updateStore((data) => {
    const row = valid(data);
    const user = row && data.users.find((item) => item.id === row.userId);
    if (!row || !user) throw new AppError("This reset link is invalid or has expired.");
    const at = iso(now);
    for (const item of data.resetTokens) {
      if (item.userId === user.id && !item.usedAt) item.usedAt = at;
    }
    applyNewPassword(user, passwordHash, at, config);
    data.sessions = data.sessions.filter((item) => item.userId !== user.id);
    authEvent(data, "auth.password_reset", "Password was reset and all sessions were signed out.", user.id);
    return { email: user.email, userId: user.id };
  });
  securityLog({ type: "auth.password_reset", outcome: "success", actorId: result.userId, ip: context.ip });
  await passwordChangedMail(result.email);
}

export async function changePassword(userId: string, current: string, next: string, context: RequestContext = {}) {
  const config = securityConfig();
  const snapshot = await readStore((data) => {
    const user = data.users.find((item) => item.id === userId);
    return user
      ? {
          hash: user.passwordHash,
          history: (user.passwordHistory ?? []).slice(0, config.passwordHistory),
          email: user.email,
          name: user.fullName,
          changedAt: user.passwordChangedAt,
          mustChange: user.mustChangePassword,
        }
      : null;
  });
  if (!snapshot || !(await verifySecret(current, snapshot.hash))) {
    await updateStore((data) => authEvent(data, "auth.password_change_failed", "Password change refused: wrong current password.", userId));
    securityLog({ type: "auth.password_change", outcome: "failure", actorId: userId, ip: context.ip, detail: "wrong_current_password" });
    await failureDelay();
    throw new AppError("Current password is incorrect.", 401, "unauthorized");
  }
  if (!snapshot.mustChange && config.passwordMinAgeHours > 0 && snapshot.changedAt) {
    if (Date.now() - Date.parse(snapshot.changedAt) < config.passwordMinAgeHours * 3_600_000) {
      throw new AppError("You changed your password recently. Try again later.");
    }
  }
  const issues = passwordIssues(next, { email: snapshot.email, name: snapshot.name }, config);
  if (issues.length) throw new AppError(issues[0]);
  await assertNotReused(next, [snapshot.hash, ...snapshot.history]);
  const passwordHash = await hashSecret(next);
  const email = await updateStore((data) => {
    const user = data.users.find((item) => item.id === userId);
    if (!user || user.passwordHash !== snapshot.hash) {
      throw new AppError("Your password was changed elsewhere. Sign in again.", 409, "conflict");
    }
    applyNewPassword(user, passwordHash, new Date().toISOString(), config);
    data.sessions = data.sessions.filter((item) => item.userId !== user.id);
    authEvent(data, "auth.password_changed", "Password changed and all sessions were signed out.", user.id);
    return user.email;
  });
  securityLog({ type: "auth.password_change", outcome: "success", actorId: userId, ip: context.ip });
  await passwordChangedMail(email);
}

// ---------------------------------------------------------------- Additional authentication (T338)

/** How long one additional authentication covers critical requests in a session. */
export const STEP_UP_MINUTES = 10;
const RECOVERY_CODE_COUNT = 8;
const MFA_SETUP_MINUTES = 15;

function newRecoveryCode(): string {
  const raw = base32Encode(randomBytes(7)).slice(0, 10);
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

function recoveryDigest(code: string): string {
  return sha256(`recovery:${code.toUpperCase().replace(/[^A-Z2-7]/g, "")}`);
}

/** Whether the session has a recent additional authentication, and whether the account has a second factor. */
export async function stepUpStatus(token: string | undefined): Promise<{ fresh: boolean; mfaEnabled: boolean } | null> {
  if (!token || token.length > 200) return null;
  const tokenHash = sha256(token);
  const now = Date.now();
  return readStore((data) => {
    const session = data.sessions.find((item) => item.tokenHash === tokenHash);
    if (!session) return null;
    const user = data.users.find((item) => item.id === session.userId);
    const fresh = Boolean(session.stepUpAt && now - Date.parse(session.stepUpAt) <= STEP_UP_MINUTES * 60_000);
    return { fresh, mfaEnabled: Boolean(user?.mfa) };
  });
}

/** Starts TOTP enrollment: a new random secret, shown once to the account owner. */
export async function beginMfaSetup(userId: string, context: RequestContext = {}) {
  const secret = createTotpSecret();
  const email = await updateStore((data) => {
    const user = data.users.find((item) => item.id === userId);
    if (!user) throw new AppError("Account not found.", 401, "unauthorized");
    if (user.mfa) throw new AppError("Two-step verification is already on.", 409, "conflict");
    user.mfaPending = { secret, createdAt: new Date().toISOString() };
    authEvent(data, "auth.mfa_setup", "Two-step verification setup started.", user.id);
    return user.email;
  });
  securityLog({ type: "auth.mfa_setup", outcome: "info", actorId: userId, ip: context.ip });
  return { secret, otpauthUri: otpauthUri(secret, email) };
}

/** Confirms enrollment with a first valid code; returns one-time recovery codes (stored only as hashes). */
export async function enableMfa(userId: string, code: string, sessionToken: string | undefined, context: RequestContext = {}) {
  const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  const tokenHash = sessionToken ? sha256(sessionToken) : "";
  const now = Date.now();
  const enabled = await updateStore((data) => {
    const user = data.users.find((item) => item.id === userId);
    if (!user) throw new AppError("Account not found.", 401, "unauthorized");
    if (user.mfa) throw new AppError("Two-step verification is already on.", 409, "conflict");
    if (!user.mfaPending || now - Date.parse(user.mfaPending.createdAt) > MFA_SETUP_MINUTES * 60_000) {
      throw new AppError("Start the setup again.", 409, "conflict");
    }
    const counter = verifyTotp(user.mfaPending.secret, code, now);
    if (counter === null) {
      authEvent(data, "auth.mfa_setup_failed", "Two-step verification setup: wrong code.", user.id);
      return false;
    }
    user.mfa = { secret: user.mfaPending.secret, enabledAt: iso(now), lastCounter: counter, recoveryCodeHashes: recoveryCodes.map(recoveryDigest) };
    user.mfaPending = null;
    const session = data.sessions.find((item) => item.tokenHash === tokenHash && item.userId === user.id);
    if (session) session.stepUpAt = iso(now);
    authEvent(data, "auth.mfa_enabled", "Two-step verification turned on.", user.id);
    return true;
  });
  securityLog({ type: "auth.mfa_enabled", outcome: enabled ? "success" : "failure", actorId: userId, ip: context.ip });
  if (!enabled) {
    await failureDelay();
    throw new AppError("That code is not valid. Check the time on your device and try again.", 400, "invalid_code");
  }
  return { recoveryCodes };
}

/** Turns the second factor off (customers only; staff accounts must keep it). */
export async function disableMfa(userId: string, context: RequestContext = {}) {
  await updateStore((data) => {
    const user = data.users.find((item) => item.id === userId);
    if (!user) throw new AppError("Account not found.", 401, "unauthorized");
    if (requiresSecondFactor(user.role)) throw new AppError("Staff accounts must keep two-step verification.", 403, "forbidden");
    user.mfa = null;
    user.mfaPending = null;
    authEvent(data, "auth.mfa_disabled", "Two-step verification turned off.", user.id);
  });
  securityLog({ type: "auth.mfa_disabled", outcome: "success", actorId: userId, ip: context.ip });
}

/**
 * Step-up for critical requests. Accounts with a second factor must use it (a TOTP code, never
 * reused, or a one-time recovery code); staff accounts must have one; other accounts re-enter
 * their password. Success replaces the session token (a new session ticket at the privilege
 * change) and covers critical requests for STEP_UP_MINUTES.
 */
export async function stepUp(userId: string, sessionToken: string | undefined, input: { code?: string; password?: string }, context: RequestContext = {}) {
  const oldHash = sessionToken ? sha256(sessionToken) : "";
  const snapshot = await readStore((data) => {
    const user = data.users.find((item) => item.id === userId);
    return user ? { hash: user.passwordHash, mfa: Boolean(user.mfa), staff: requiresSecondFactor(user.role) } : null;
  });
  if (!snapshot) throw new AppError("Sign in to continue.", 401, "unauthorized");
  if (!snapshot.mfa && snapshot.staff) throw new AppError("Set up two-step verification in Settings to continue.", 403, "mfa_enrollment_required");
  if (!snapshot.mfa && !input.password) throw new AppError("Enter your password to continue.", 400, "bad_request");
  if (snapshot.mfa && !input.code) throw new AppError("Enter the code from your authenticator app.", 400, "bad_request");
  const passwordOk = !snapshot.mfa && (await verifySecret(input.password ?? "", snapshot.hash));
  const now = Date.now();
  const token = randomToken();
  const result = await updateStore((data) => {
    const user = data.users.find((item) => item.id === userId);
    const session = data.sessions.find((item) => item.tokenHash === oldHash && item.userId === userId);
    if (!user || !session) return { ok: false as const, method: "session" };
    let method = "password";
    let ok = false;
    if (user.mfa) {
      const code = (input.code ?? "").replace(/\s/g, "");
      const counter = verifyTotp(user.mfa.secret, code, now);
      method = "totp";
      if (counter !== null && counter > user.mfa.lastCounter) {
        user.mfa.lastCounter = counter;
        ok = true;
      } else if (code.length >= 10) {
        const index = user.mfa.recoveryCodeHashes.indexOf(recoveryDigest(code));
        method = "recovery_code";
        if (index >= 0) {
          user.mfa.recoveryCodeHashes.splice(index, 1);
          ok = true;
        }
      }
    } else {
      ok = passwordOk && user.passwordHash === snapshot.hash;
    }
    if (!ok) {
      authEvent(data, "auth.step_up_failed", `Additional authentication failed (${method}).`, user.id);
      return { ok: false as const, method };
    }
    session.tokenHash = sha256(token);
    session.stepUpAt = iso(now);
    session.lastSeenAt = iso(now);
    authEvent(data, "auth.step_up", `Additional authentication succeeded (${method}).`, user.id);
    return { ok: true as const, method };
  });
  securityLog({ type: "auth.step_up", outcome: result.ok ? "success" : "failure", actorId: userId, ip: context.ip, detail: result.method });
  if (!result.ok) {
    await failureDelay();
    throw new AppError(result.method === "session" ? "Sign in to continue." : "That code or password is not valid.", 401, "unauthorized");
  }
  return { token, validUntil: iso(now + STEP_UP_MINUTES * 60_000) };
}

// ---------------------------------------------------------------- Anti-automation for password reset (T2)

/** Issues a single-use proof-of-work challenge (stored server-side, expires after CHALLENGE_MINUTES). */
export async function issueChallenge() {
  const now = Date.now();
  const challenge = { id: randomUUID(), salt: randomToken(16), difficulty: POW_DIFFICULTY, expiresAt: iso(now + CHALLENGE_MINUTES * 60_000), usedAt: null };
  await updateStore((data) => {
    data.challenges = data.challenges.filter((item) => Date.parse(item.expiresAt) > now && !item.usedAt).slice(-500);
    data.challenges.push(challenge);
  });
  return { id: challenge.id, salt: challenge.salt, difficulty: challenge.difficulty, expiresAt: challenge.expiresAt };
}

/** Accepts a solved challenge once; unknown, expired, reused or unsolved challenges are refused. */
export async function consumeChallenge(id: string, nonce: string, context: RequestContext = {}) {
  const now = Date.now();
  const accepted = await updateStore((data) => {
    const challenge = data.challenges.find((item) => item.id === id);
    if (!challenge || challenge.usedAt || Date.parse(challenge.expiresAt) <= now || !verifyPow(challenge.salt, nonce, challenge.difficulty)) return false;
    challenge.usedAt = iso(now);
    return true;
  });
  if (!accepted) {
    securityLog({ type: "auth.challenge_failed", outcome: "blocked", ip: context.ip, detail: "missing, expired, reused or unsolved anti-automation challenge" });
    throw new AppError("The automated-request check failed. Reload the page and try again.", 400, "challenge_failed");
  }
}
