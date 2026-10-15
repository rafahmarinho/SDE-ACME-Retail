"use client";

import { FormEvent, useState } from "react";
import { ErrorState } from "@/components/states";

export default function RecoverPage() {
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [mail, setMail] = useState<{ subject: string; body: string }[]>([]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/auth/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: form.get("email") }),
    });
    const body = await response.json();
    if (!response.ok) setError(body.error ?? "Could not start recovery.");
    else {
      setMessage(body.message);
      const inbox = await fetch("/api/mail");
      if (inbox.ok) setMail(await inbox.json());
    }
  }

  return (
    <section className="panel mx-auto max-w-lg space-y-3 p-6">
      <h1 className="text-2xl font-semibold">Reset password</h1>
      <p className="text-sm text-muted">We will not say whether the email exists. In this demo, the message appears in the simulated mailbox below.</p>
      {error ? <ErrorState message={error} /> : null}
      {message ? <p className="banner-ok">{message}</p> : null}
      <form className="space-y-3" onSubmit={(event) => void submit(event)}>
        <input className="field" type="email" name="email" placeholder="Email" required />
        <button className="btn">Send reset link</button>
      </form>
      {mail.map((item) => (
        <article key={item.body} className="rounded-xl bg-[#f3f6f2] p-3 text-sm">
          <strong>{item.subject}</strong>
          <p className="mt-1">{item.body}</p>
        </article>
      ))}
    </section>
  );
}
