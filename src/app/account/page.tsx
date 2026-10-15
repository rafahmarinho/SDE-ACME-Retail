"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ErrorState, LoadingState } from "@/components/states";
import type { PublicUser } from "@/lib/types";

export default function AccountPage() {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/session").then(async (response) => {
      const body = await response.json();
      if (!body.user) setError("Sign in to view your account.");
      else setUser(body.user);
    });
  }, []);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/";
  }

  if (!user && !error) return <LoadingState label="Loading account..." />;
  if (!user) return <ErrorState message={error} />;
  return (
    <section className="space-y-4">
      <h1 className="text-3xl font-semibold">Hello, {user.fullName}</h1>
      <p className="text-muted">{user.email} · {user.role}</p>
      <div className="flex flex-wrap gap-2">
        <Link className="btn secondary" href="/account/profile">Profile</Link>
        <Link className="btn secondary" href="/account/settings">Settings</Link>
        <Link className="btn secondary" href="/account/orders">Orders</Link>
        <Link className="btn secondary" href="/account/returns">Returns</Link>
        <button className="btn" type="button" onClick={() => void logout()}>Sign out</button>
      </div>
    </section>
  );
}
