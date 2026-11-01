"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { ErrorState, LoadingState } from "@/components/states";
import { apiSend } from "@/lib/api-client";
import { FIELD_PURPOSES } from "@/lib/privacy";

function purpose(field: keyof typeof FIELD_PURPOSES) {
  const item = FIELD_PURPOSES[field];
  return { title: item.why, hint: `${item.required ? "Required" : "Optional"}. ${item.required ? item.why : item.why.replace(/^Optional\. /, "")}` };
}

export default function ProfilePage() {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [phoneAllowed, setPhoneAllowed] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    Promise.all([fetch("/api/session"), fetch("/api/account/privacy")]).then(async ([response, privacyResponse]) => {
      const body = await response.json();
      const privacy = privacyResponse.ok ? await privacyResponse.json() : null;
      if (!body.user) setError("Sign in to edit your profile.");
      else {
        setName(body.user.fullName);
        setPhone(body.user.phone ?? "");
      }
      setAccepted(Boolean(privacy?.accepted));
      setPhoneAllowed(Boolean(privacy?.activities?.find((item: { id: string; allowed: boolean }) => item.id === "delivery_phone")?.allowed));
      setReady(true);
    });
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget);
    const response = await apiSend("/api/account", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: name,
        phone,
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
  if (!accepted) {
    return (
      <section className="panel max-w-xl space-y-3 p-5">
        <h1 className="text-2xl font-semibold">Profile</h1>
        {error ? <ErrorState message={error} /> : null}
        <p className="text-sm">Before you add personal details, review the privacy notice and decide on the optional uses of your information.</p>
        <Link className="btn" href="/account/privacy?next=/account/profile">Review and decide</Link>
      </section>
    );
  }
  const fields = { fullName: purpose("fullName"), phone: purpose("phone"), line1: purpose("line1"), city: purpose("city"), region: purpose("region"), postalCode: purpose("postalCode") };
  return (
    <form className="panel max-w-xl space-y-3 p-5" onSubmit={(event) => void submit(event)}>
      <h1 className="text-2xl font-semibold">Profile</h1>
      {error ? <ErrorState message={error} /> : null}
      {message ? <p className="banner-ok">{message}</p> : null}
      <label className="block text-sm" title={fields.fullName.title}>Full name<input className="field mt-1" value={name} onChange={(event) => setName(event.target.value)} required /><span className="mt-1 block text-xs text-muted">{fields.fullName.hint}</span></label>
      <label className="block text-sm" title={fields.phone.title}>Phone
        <input className="field mt-1" value={phone} onChange={(event) => setPhone(event.target.value)} disabled={!phoneAllowed && !phone} />
        <span className="mt-1 block text-xs text-muted">{fields.phone.hint} {phoneAllowed ? "" : <Link className="text-accent" href="/account/privacy">Allow delivery contact by phone</Link>}</span>
      </label>
      <label className="block text-sm" title={fields.line1.title}>Street address<input className="field mt-1" name="line1" required /><span className="mt-1 block text-xs text-muted">{fields.line1.hint}</span></label>
      <label className="block text-sm" title={fields.city.title}>City<input className="field mt-1" name="city" required /><span className="mt-1 block text-xs text-muted">{fields.city.hint}</span></label>
      <label className="block text-sm" title={fields.region.title}>State<input className="field mt-1" name="region" defaultValue="CA" required /><span className="mt-1 block text-xs text-muted">{fields.region.hint}</span></label>
      <label className="block text-sm" title={fields.postalCode.title}>Postal code<input className="field mt-1" name="postalCode" required /><span className="mt-1 block text-xs text-muted">{fields.postalCode.hint}</span></label>
      <p className="text-sm text-muted">Product update e-mails and other optional uses are managed on <Link className="text-accent" href="/account/privacy">Privacy</Link>.</p>
      <button className="btn">Save profile</button>
    </form>
  );
}
