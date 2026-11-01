"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useState } from "react";
import { ErrorState } from "@/components/states";
import { safeNextPath } from "@/lib/redirect";
import { apiSend, rememberCsrfToken } from "@/lib/api-client";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const response = await apiSend("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
    });
    const body = await response.json();
    setLoading(false);
    // Sign-in replaces the anti-CSRF secret; keep the new token for the next requests.
    if (response.ok) rememberCsrfToken(body.csrfToken);
    if (!response.ok) setError(body.error ?? "Could not sign in.");
    else if (body.user.mustChangePassword) router.push("/account/settings?required=1");
    else router.push(safeNextPath(params.get("next"), (body.permissions ?? []).includes("orders.purchase") ? "/account" : "/office"));
  }

  return (
    <form className="panel mx-auto max-w-md space-y-3 p-6" onSubmit={(event) => void submit(event)}>
      <h1 className="text-2xl font-semibold">Sign in</h1>
      {error ? <ErrorState message={error} /> : null}
      <input className="field" name="email" type="email" autoComplete="username" placeholder="Email" required />
      <input className="field" name="password" type="password" autoComplete="off" placeholder="Password" required />
      <button className="btn w-full" disabled={loading}>{loading ? "Signing in..." : "Sign in"}</button>
      <Link href="/recover" className="block text-sm text-accent">Forgot password</Link>
    </form>
  );
}

export default function LoginPage() {
  return <Suspense><LoginForm /></Suspense>;
}
