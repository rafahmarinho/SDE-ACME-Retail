"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useEffect, useState } from "react";
import { ErrorState } from "@/components/states";
import { apiSend } from "@/lib/api-client";

/** Two-step verification (TOTP): required for staff, optional for customers. */
function TwoStepSection() {
  const [state, setState] = useState<{ enabled: boolean; staff: boolean } | null>(null);
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    fetch("/api/session").then(async (response) => {
      const body = response.ok ? await response.json() : null;
      if (!active || !body?.user) return;
      const permissions: string[] = body.permissions ?? [];
      setState({ enabled: Boolean(body.user.mfaEnabled), staff: permissions.some((permission) => permission !== "orders.purchase") });
    });
    return () => {
      active = false;
    };
  }, [reloadKey]);

  async function start() {
    setError("");
    const response = await apiSend("/api/account/mfa/setup", { method: "POST", headers: { "Content-Type": "application/json" } });
    const body = await response.json();
    if (!response.ok) setError(body.error ?? "Could not start the setup.");
    else setSetup(body);
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const code = String(new FormData(event.currentTarget).get("code") ?? "").replace(/\s/g, "");
    const response = await apiSend("/api/account/mfa/enable", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
    const body = await response.json();
    if (!response.ok) setError(body.error ?? "That code is not valid.");
    else {
      setSetup(null);
      setRecoveryCodes(body.recoveryCodes);
      setReloadKey((key) => key + 1);
    }
  }

  async function turnOff() {
    setError("");
    const response = await apiSend("/api/account/mfa/disable", { method: "POST", headers: { "Content-Type": "application/json" } });
    const body = await response.json();
    if (!response.ok) setError(body.error ?? "Could not turn off two-step verification.");
    else setReloadKey((key) => key + 1);
  }

  if (!state) return null;
  return (
    <section className="panel max-w-md space-y-3 p-5" aria-labelledby="two-step">
      <h2 id="two-step" className="text-xl font-semibold">Two-step verification</h2>
      <p className="text-sm text-muted">
        A code from an authenticator app confirms refunds, profile changes and other sensitive actions.{state.staff ? " Staff accounts need it for those actions." : ""}
      </p>
      {error ? <ErrorState message={error} /> : null}
      {recoveryCodes.length ? (
        <div className="space-y-2">
          <p className="banner-ok">Two-step verification is on. Save these recovery codes now; each works once and they are not shown again.</p>
          <ul className="grid grid-cols-2 gap-1 font-mono text-sm">{recoveryCodes.map((item) => <li key={item}>{item}</li>)}</ul>
        </div>
      ) : null}
      {state.enabled && !recoveryCodes.length ? <p className="text-sm">Two-step verification is on.</p> : null}
      {state.enabled && !state.staff ? <button className="btn secondary" type="button" onClick={() => void turnOff()}>Turn off</button> : null}
      {!state.enabled && !setup ? <button className="btn" type="button" onClick={() => void start()}>Set up</button> : null}
      {setup ? (
        <form className="space-y-2" onSubmit={(event) => void confirm(event)}>
          <p className="text-sm">Add this key to your authenticator app, or open the setup link on your phone:</p>
          <p className="break-all font-mono text-sm">{setup.secret.match(/.{1,4}/g)?.join(" ")}</p>
          <a className="text-sm text-accent" href={setup.otpauthUri}>Open in authenticator app</a>
          <input className="field" name="code" inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code" aria-label="6-digit code" required />
          <button className="btn">Turn on</button>
        </form>
      ) : null}
    </section>
  );
}

function SettingsForm() {
  const router = useRouter();
  const required = useSearchParams().get("required") === "1";
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget);
    const response = await apiSend("/api/account/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current: form.get("current"), next: form.get("next") }),
    });
    const body = await response.json();
    if (!response.ok) setError(body.error ?? "Could not change the password.");
    else {
      setMessage("Password updated. Sign in again.");
      router.push("/login");
    }
  }

  return (
    <div className="space-y-6">
      <form className="panel max-w-md space-y-3 p-5" onSubmit={(event) => void submit(event)}>
        <h1 className="text-2xl font-semibold">Settings</h1>
        {required ? <p className="banner-error">Choose your own password before you continue. The initial password works only once.</p> : null}
        <p className="text-sm text-muted">Passwords need 12 characters, mixed case, a digit, and a symbol. Common words, your name or e-mail, and your recent passwords are not accepted. Changing it signs out every session.</p>
        {error ? <ErrorState message={error} /> : null}
        {message ? <p className="banner-ok">{message}</p> : null}
        <input className="field" type="password" name="current" autoComplete="off" placeholder="Current password" required />
        <input className="field" type="password" name="next" autoComplete="off" placeholder="New password" required />
        <button className="btn">Change password</button>
      </form>
      {required ? null : <TwoStepSection />}
    </div>
  );
}

export default function SettingsPage() {
  return <Suspense><SettingsForm /></Suspense>;
}
