"use client";

import { FormEvent, useState } from "react";
import { ErrorState } from "@/components/states";
import { apiSend } from "@/lib/api-client";

function leadingZeroBits(digest: Uint8Array): number {
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

/**
 * Anti-automation check without a visual puzzle: finds the nonce the server's proof-of-work
 * challenge asks for (src/lib/pow.ts), which takes about a second in a browser.
 */
async function solveChallenge(salt: string, difficulty: number): Promise<string> {
  const encoder = new TextEncoder();
  for (let nonce = 0; ; nonce += 1) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`${salt}:${nonce}`)));
    if (leadingZeroBits(digest) >= difficulty) return String(nonce);
  }
}

export default function RecoverPage() {
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      const challengeResponse = await apiSend("/api/auth/challenge", { method: "POST", headers: { "Content-Type": "application/json" } });
      const challenge = await challengeResponse.json();
      if (!challengeResponse.ok) {
        setError(challenge.error ?? "Could not start recovery.");
        return;
      }
      const nonce = await solveChallenge(challenge.salt, challenge.difficulty);
      const response = await apiSend("/api/auth/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: form.get("email"), challengeId: challenge.id, nonce }),
      });
      const body = await response.json();
      if (!response.ok) setError(body.error ?? "Could not start recovery.");
      else setMessage(body.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel mx-auto max-w-lg space-y-3 p-6">
      <h1 className="text-2xl font-semibold">Reset password</h1>
      <p className="text-sm text-muted">We send a one-time link to the email address registered on the account. We will not say whether the email exists.</p>
      {error ? <ErrorState message={error} /> : null}
      {message ? <p className="banner-ok">{message}</p> : null}
      <form className="space-y-3" onSubmit={(event) => void submit(event)}>
        <input className="field" type="email" name="email" placeholder="Email" aria-label="Email" required />
        <button className="btn" disabled={busy}>{busy ? "Checking this is not an automated request..." : "Send reset link"}</button>
      </form>
      <p className="text-xs text-muted">To stop automated requests, your browser solves a short calculation before the request is sent. No image or audio puzzle is needed.</p>
    </section>
  );
}
