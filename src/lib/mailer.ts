import { securityConfig } from "./config";
import { appErrorLog, securityLog } from "./security-log";
import { randomUUID } from "node:crypto";

/**
 * Out-of-band e-mail delivery. Messages go only to the address registered on the account and are
 * never stored in the application database or returned by the API.
 * - webhook: HTTPS POST to the configured e-mail provider (production).
 * - console: prints the message on the developer's terminal (refused in production).
 * - memory: keeps the last messages in this process for automated tests.
 * - disabled: drops the message and logs that no transport is configured.
 *
 * Every message goes to one recipient (no CC lists), carries the standard disclaimer and the
 * reminder that ACME Retail never asks for credentials by e-mail; marketing messages also carry a
 * List-Unsubscribe header pointing to the page where consent is withdrawn.
 */
export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  category?: "transactional" | "marketing";
  /** Where the recipient withdraws consent (marketing messages). */
  unsubscribeUrl?: string;
}

export interface DeliveredMail {
  to: string;
  subject: string;
  text: string;
  category: "transactional" | "marketing";
  headers: Record<string, string>;
}

/** Standard footer of every outbound message (anti-phishing notice and disclaimer). */
export const MAIL_FOOTER =
  "ACME Retail will never ask for your password, verification codes or card details by e-mail. Treat any such request as phishing.\n" +
  "This automated message is intended only for the addressee. If you received it by mistake, delete it; replies are not read.";

const outbox: DeliveredMail[] = [];

export function composeMail(mail: OutgoingMail): DeliveredMail {
  const category = mail.category ?? "transactional";
  const headers: Record<string, string> = { "X-ACME-Category": category };
  if (category === "marketing" && mail.unsubscribeUrl) headers["List-Unsubscribe"] = `<${mail.unsubscribeUrl}>`;
  return { to: mail.to, subject: mail.subject, text: `${mail.text}\n\n--\n${MAIL_FOOTER}`, category, headers };
}

export async function sendMail(input: OutgoingMail): Promise<void> {
  const config = securityConfig();
  const mail = composeMail(input);
  if (config.mailTransport === "memory") {
    outbox.unshift(mail);
    outbox.splice(50);
    return;
  }
  if (config.mailTransport === "console") {
    console.info(`[dev mail] to=${mail.to} subject="${mail.subject}"\n${mail.text}`);
    return;
  }
  if (config.mailTransport === "webhook" && config.mailWebhookUrl) {
    try {
      const response = await fetch(config.mailWebhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(process.env.MAIL_WEBHOOK_TOKEN ? { Authorization: `Bearer ${process.env.MAIL_WEBHOOK_TOKEN}` } : {}),
        },
        body: JSON.stringify(mail),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`Mail provider answered ${response.status}.`);
    } catch (error) {
      appErrorLog(randomUUID(), error, { path: "mail" });
    }
    return;
  }
  securityLog({ type: "mail.not_sent", outcome: "failure", detail: "No mail transport is configured." });
}

/** Messages captured by the memory transport (tests and local tooling only). */
export function devOutbox(): readonly DeliveredMail[] {
  return outbox;
}

export function clearDevOutbox() {
  outbox.length = 0;
}
