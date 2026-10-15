import { randomUUID } from "node:crypto";
import { AppError } from "../lib/errors";
import { updateStore, readStore } from "../lib/db/store";
import { hashSecret, passwordIssues, randomToken, sha256, verifySecret, sanitizeText } from "../lib/security";
import { toPublicUser, type PublicUser, type Session } from "../lib/types";

const SESSION_MS = 1000 * 60 * 60 * 12;
const IDLE_MS = 1000 * 60 * 30;
const LOCK_MS = 1000 * 60 * 15;

export async function login(email: string, password: string): Promise<{ token: string; user: PublicUser }> {
  const normalized = sanitizeText(email, 120).toLowerCase();
  return updateStore((data) => {
    const user = data.users.find((item) => item.email === normalized);
    const invalid = new AppError("Email or password is incorrect.", 401, "unauthorized");
    if (!user) {
      data.events.unshift({
        id: randomUUID(),
        at: new Date().toISOString(),
        type: "auth.failure",
        message: "Login failed for an unknown account.",
        orderId: null,
        actorId: null,
      });
      throw invalid;
    }
    if (user.lockedUntil && Date.parse(user.lockedUntil) > Date.now()) {
      throw new AppError("This account is temporarily locked. Try again later.", 423, "locked");
    }
    if (!verifySecret(password, user.passwordHash)) {
      user.failedLogins += 1;
      if (user.failedLogins >= 8) {
        user.lockedUntil = new Date(Date.now() + LOCK_MS).toISOString();
        user.failedLogins = 0;
      }
      data.events.unshift({
        id: randomUUID(),
        at: new Date().toISOString(),
        type: "auth.failure",
        message: "Login failed.",
        orderId: null,
        actorId: user.id,
      });
      throw invalid;
    }
    user.failedLogins = 0;
    user.lockedUntil = null;
    data.sessions = data.sessions.filter((item) => item.userId !== user.id);
    const token = randomToken();
    const session: Session = {
      id: randomUUID(),
      userId: user.id,
      tokenHash: sha256(token),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + SESSION_MS).toISOString(),
      lastSeenAt: new Date().toISOString(),
    };
    data.sessions.push(session);
    data.events.unshift({
      id: randomUUID(),
      at: new Date().toISOString(),
      type: "auth.success",
      message: "Login succeeded.",
      orderId: null,
      actorId: user.id,
    });
    return { token, user: toPublicUser(user) };
  });
}

export async function logout(token: string) {
  const tokenHash = sha256(token);
  await updateStore((data) => {
    data.sessions = data.sessions.filter((item) => item.tokenHash !== tokenHash);
  });
}

export async function sessionUser(token: string | undefined): Promise<PublicUser | null> {
  if (!token) return null;
  const tokenHash = sha256(token);
  return updateStore((data) => {
    const session = data.sessions.find((item) => item.tokenHash === tokenHash);
    if (!session) return null;
    if (Date.parse(session.expiresAt) <= Date.now() || Date.now() - Date.parse(session.lastSeenAt) > IDLE_MS) {
      data.sessions = data.sessions.filter((item) => item.id !== session.id);
      return null;
    }
    session.lastSeenAt = new Date().toISOString();
    const user = data.users.find((item) => item.id === session.userId);
    return user ? toPublicUser(user) : null;
  });
}

export async function requestReset(email: string, sessionKey: string) {
  const normalized = sanitizeText(email, 120).toLowerCase();
  await updateStore((data) => {
    const user = data.users.find((item) => item.email === normalized);
    if (!user) return;
    const token = randomToken(24);
    data.resetTokens.push({
      id: randomUUID(),
      userId: user.id,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      usedAt: null,
    });
    data.mail.unshift({
      id: randomUUID(),
      to: user.email,
      subject: "Reset your ACME Retail password",
      body: `Use this one-time link within 30 minutes: /reset?token=${token}`,
      createdAt: new Date().toISOString(),
      sessionKey,
    });
    data.events.unshift({
      id: randomUUID(),
      at: new Date().toISOString(),
      type: "auth.reset_requested",
      message: "Password reset requested.",
      orderId: null,
      actorId: user.id,
    });
  });
}

export async function resetPassword(token: string, password: string) {
  const issues = passwordIssues(password);
  if (issues.length) throw new AppError(issues[0]);
  await updateStore((data) => {
    const tokenHash = sha256(token);
    const row = data.resetTokens.find((item) => item.tokenHash === tokenHash && !item.usedAt);
    if (!row || Date.parse(row.expiresAt) <= Date.now()) {
      throw new AppError("This reset link is invalid or has expired.");
    }
    const user = data.users.find((item) => item.id === row.userId);
    if (!user) throw new AppError("This reset link is invalid or has expired.");
    row.usedAt = new Date().toISOString();
    user.passwordHash = hashSecret(password);
    user.failedLogins = 0;
    user.lockedUntil = null;
    data.sessions = data.sessions.filter((item) => item.userId !== user.id);
    data.events.unshift({
      id: randomUUID(),
      at: new Date().toISOString(),
      type: "auth.password_reset",
      message: "Password was reset and other sessions were signed out.",
      orderId: null,
      actorId: user.id,
    });
  });
}

export async function changePassword(userId: string, current: string, next: string) {
  const issues = passwordIssues(next);
  if (issues.length) throw new AppError(issues[0]);
  await updateStore((data) => {
    const user = data.users.find((item) => item.id === userId);
    if (!user || !verifySecret(current, user.passwordHash)) {
      throw new AppError("Current password is incorrect.", 401, "unauthorized");
    }
    user.passwordHash = hashSecret(next);
    data.sessions = data.sessions.filter((item) => item.userId !== user.id);
  });
}

export async function demoMail(sessionKey: string, email?: string) {
  return readStore((data) =>
    data.mail
      .filter((item) => (sessionKey && item.sessionKey === sessionKey) || (email && item.to === email))
      .slice(0, 10)
      .map((item) => ({ id: item.id, to: item.to, subject: item.subject, body: item.body, createdAt: item.createdAt })),
  );
}
