"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { ErrorState } from "@/components/states";
import { apiSend } from "@/lib/api-client";

let pendingToken = "";

/**
 * The token arrives in the URL fragment, which browsers never send to the server or in the
 * Referer header. It is moved into memory and removed from the address bar right away.
 */
function takeToken(): string {
  const fromHash = new URLSearchParams(window.location.hash.slice(1)).get("token");
  if (fromHash) {
    pendingToken = fromHash;
    window.history.replaceState(null, "", window.location.pathname);
  }
  return pendingToken;
}

export default function ResetPage() {
  const router = useRouter();
  const [error, setError] = useState("");

  useEffect(() => {
    takeToken();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get("password"));
    const response = await apiSend("/api/auth/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: takeToken(), password }),
    });
    const body = await response.json();
    if (!response.ok) setError(body.error ?? "Could not reset the password.");
    else {
      pendingToken = "";
      router.push("/login");
    }
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
