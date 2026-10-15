"use client";

import { FormEvent, useState } from "react";
import { ErrorState } from "@/components/states";

export default function SettingsPage() {
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/account/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current: form.get("current"), next: form.get("next") }),
    });
    const body = await response.json();
    if (!response.ok) setError(body.error ?? "Could not change the password.");
    else setMessage("Password updated. Sign in again.");
  }

  return (
    <form className="panel max-w-md space-y-3 p-5" onSubmit={(event) => void submit(event)}>
      <h1 className="text-2xl font-semibold">Settings</h1>
      <p className="text-sm text-muted">Passwords need 12 characters, mixed case, a digit, and a symbol. Changing it signs out other sessions.</p>
      {error ? <ErrorState message={error} /> : null}
      {message ? <p className="banner-ok">{message}</p> : null}
      <input className="field" type="password" name="current" autoComplete="off" placeholder="Current password" required />
      <input className="field" type="password" name="next" autoComplete="off" placeholder="New password" required />
      <button className="btn">Change password</button>
    </form>
  );
}
