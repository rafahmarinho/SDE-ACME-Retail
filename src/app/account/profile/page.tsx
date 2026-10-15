"use client";

import { FormEvent, useEffect, useState } from "react";
import { ErrorState, LoadingState } from "@/components/states";

export default function ProfilePage() {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [marketing, setMarketing] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    fetch("/api/session").then(async (response) => {
      const body = await response.json();
      if (!body.user) setError("Sign in to edit your profile.");
      else {
        setName(body.user.fullName);
        setPhone(body.user.phone ?? "");
        setMarketing(Boolean(body.user.marketingOptIn));
      }
      setReady(true);
    });
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/account", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: name,
        phone,
        marketingOptIn: marketing,
        address: {
          fullName: name,
          line1: String(form.get("line1")),
          city: String(form.get("city")),
          region: String(form.get("region")),
          postalCode: String(form.get("postalCode")),
          country: "US",
        },
      }),
    });
    const body = await response.json();
    if (!response.ok) setError(body.error ?? "Could not save your profile.");
    else setMessage("Profile saved.");
  }

  if (!ready) return <LoadingState label="Loading profile..." />;
  return (
    <form className="panel max-w-xl space-y-3 p-5" onSubmit={(event) => void submit(event)}>
      <h1 className="text-2xl font-semibold">Profile</h1>
      {error ? <ErrorState message={error} /> : null}
      {message ? <p className="banner-ok">{message}</p> : null}
      <input className="field" value={name} onChange={(event) => setName(event.target.value)} required />
      <input className="field" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="Phone" />
      <input className="field" name="line1" placeholder="Street address" required />
      <input className="field" name="city" placeholder="City" required />
      <input className="field" name="region" placeholder="State" defaultValue="CA" required />
      <input className="field" name="postalCode" placeholder="Postal code" required />
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={marketing} onChange={(event) => setMarketing(event.target.checked)} /> Email me product updates</label>
      <button className="btn">Save profile</button>
    </form>
  );
}
