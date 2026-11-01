"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { apiSend, STEP_UP_EVENT, type StepUpRequest } from "@/lib/api-client";

/**
 * Additional authentication before critical requests (the server answers step_up_required).
 * Accounts with two-step verification enter a code from their authenticator app (or a recovery
 * code); other customers re-enter their password. The request is retried after confirmation.
 */
export function StepUpDialog() {
  const [open, setOpen] = useState(false);
  const [mfa, setMfa] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<StepUpRequest["resolve"] | null>(null);

  useEffect(() => {
    const onRequest = (event: Event) => {
      event.preventDefault();
      pending.current?.(false);
      pending.current = (event as CustomEvent<StepUpRequest>).detail.resolve;
      setError("");
      setOpen(true);
      fetch("/api/session", { headers: { "X-Acme-Passive": "1" } }).then(async (response) => {
        const body = response.ok ? await response.json() : null;
        setMfa(Boolean(body?.user?.mfaEnabled));
      });
    };
    window.addEventListener(STEP_UP_EVENT, onRequest);
    return () => window.removeEventListener(STEP_UP_EVENT, onRequest);
  }, []);

  function finish(confirmed: boolean) {
    pending.current?.(confirmed);
    pending.current = null;
    setOpen(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const value = String(new FormData(event.currentTarget).get("secret") ?? "");
    const response = await apiSend("/api/auth/step-up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mfa ? { code: value } : { password: value }),
    });
    if (response.ok) finish(true);
    else {
      const body = await response.json().catch(() => null);
      setError(body?.error ?? "Could not confirm your identity.");
    }
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 px-4" role="dialog" aria-modal="true" aria-labelledby="step-up-title">
      <form className="panel w-full max-w-sm space-y-3 p-5" onSubmit={(event) => void submit(event)}>
        <h2 id="step-up-title" className="text-lg font-semibold">Confirm it is you</h2>
        <p className="text-sm text-muted">
          {mfa ? "Enter the 6-digit code from your authenticator app, or one of your recovery codes." : "This action involves personal or financial data. Enter your password to continue."}
        </p>
        {error ? <p className="banner-error" role="alert">{error}</p> : null}
        <input
          className="field"
          name="secret"
          type={mfa ? "text" : "password"}
          inputMode={mfa ? "numeric" : undefined}
          autoComplete={mfa ? "one-time-code" : "off"}
          aria-label={mfa ? "Authentication code" : "Password"}
          required
          autoFocus
        />
        <div className="flex gap-2">
          <button className="btn">Confirm</button>
          <button className="btn secondary" type="button" onClick={() => finish(false)}>Cancel</button>
        </div>
      </form>
    </div>
  );
}
