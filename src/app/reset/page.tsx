"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useState } from "react";
import { ErrorState } from "@/components/states";

function ResetForm() {
  const params = useSearchParams();
  const router = useRouter();
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get("password"));
    const response = await fetch("/api/auth/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: params.get("token"), password }),
    });
    const body = await response.json();
    if (!response.ok) setError(body.error ?? "Could not reset the password.");
    else router.push("/login");
  }

  return (
    <form className="panel mx-auto max-w-md space-y-3 p-6" onSubmit={(event) => void submit(event)}>
      <h1 className="text-2xl font-semibold">Choose a new password</h1>
      {error ? <ErrorState message={error} /> : null}
      <input className="field" name="password" type="password" autoComplete="off" minLength={12} required placeholder="New password" />
      <button className="btn">Update password</button>
    </form>
  );
}

export default function ResetPage() {
  return <Suspense><ResetForm /></Suspense>;
}
