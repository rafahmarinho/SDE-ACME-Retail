"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { ErrorState, LoadingState } from "@/components/states";
import { apiSend } from "@/lib/api-client";
import { safeNextPath } from "@/lib/redirect";
import { activity, NOTICE_SUMMARY, PRIVACY_NOTICE_VERSION, PROCESSING_ACTIVITIES, WITHDRAWAL_TEXT, type ActivityId } from "@/lib/privacy";

interface PrivacyState {
  noticeVersion: string;
  accepted: boolean;
  decision: "accepted" | "declined" | null;
  decidedAt: string | null;
  consents: { id: ActivityId; granted: boolean; at: string | null }[];
  restrictions: { id: ActivityId; restricted: boolean; at: string | null }[];
  activities: { id: ActivityId; allowed: boolean }[];
  history: { id: string; at: string; action: string; items: string[]; noticeVersion: string }[];
}

/** Browser language preference stored with the decision (language and region only). */
function languagePreference() {
  return (navigator.language || "en").split("-").slice(0, 2).join("-");
}

function when(value: string | null) {
  return value ? new Date(value).toLocaleString() : "";
}

function PrivacyCenter() {
  const router = useRouter();
  const next = useSearchParams().get("next");
  const [state, setState] = useState<PrivacyState | null>(null);
  const [choices, setChoices] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/account/privacy").then(async (response) => {
      const body = await response.json();
      if (!active) return;
      if (!response.ok) setError(body.error ?? "Could not load your privacy settings.");
      else setState(body);
    });
    return () => {
      active = false;
    };
  }, []);

  async function decide(decision: "accept" | "decline") {
    setError("");
    setMessage("");
    const response = await apiSend("/api/account/privacy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, noticeVersion: PRIVACY_NOTICE_VERSION, language: languagePreference(), consents: decision === "accept" ? choices : {} }),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? "Could not save your decision.");
      return;
    }
    setState(body);
    if (decision === "accept" && next) router.push(safeNextPath(next, "/account"));
    else setMessage(decision === "accept" ? "Your choices are saved." : "You declined. We will not collect shipping or profile details until you accept the notice.");
  }

  async function change(kind: "consents" | "restrictions", id: string, value: boolean) {
    setError("");
    setMessage("");
    const response = await apiSend(`/api/account/privacy/${kind}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [id]: value }),
    });
    const body = await response.json();
    if (!response.ok) setError(body.error ?? "Could not save the change.");
    else {
      setState(body);
      setMessage("Saved. The change applies from now on.");
    }
  }

  if (!state && !error) return <LoadingState label="Loading privacy settings..." />;
  if (!state) return <ErrorState message={error} />;

  if (!state.accepted) {
    const optional = PROCESSING_ACTIVITIES.filter((item) => item.consent);
    return (
      <section className="panel mx-auto max-w-3xl space-y-4 p-6" aria-labelledby="consent-title">
        <h1 id="consent-title" className="text-2xl font-semibold">Consent to the use of your information</h1>
        <p className="text-sm text-muted">Privacy notice version {state.noticeVersion}. This form is separate from any terms of sale. {state.decision === "declined" ? "You declined earlier; you can decide again." : ""}</p>
        {error ? <ErrorState message={error} /> : null}
        {message ? <p className="banner-ok">{message}</p> : null}
        <ul className="list-disc space-y-1 pl-5 text-sm">{NOTICE_SUMMARY.map((line) => <li key={line}>{line}</li>)}</ul>
        <h2 className="font-semibold">Needed to use the store</h2>
        {PROCESSING_ACTIVITIES.filter((item) => item.required).map((item) => (
          <div key={item.id} className="text-sm">
            <p><strong>{item.name}:</strong> {item.purpose}</p>
            <p className="text-muted">Information: {item.data.join(", ")}. Kept: {item.retention} Shared with: {item.recipients.join(", ")}.</p>
          </div>
        ))}
        <h2 className="font-semibold">Optional (off unless you tick them)</h2>
        {optional.map((item) => (
          <label key={item.id} className="flex gap-2 text-sm">
            <input type="checkbox" checked={Boolean(choices[item.id])} onChange={(event) => setChoices((current) => ({ ...current, [item.id]: event.target.checked }))} />
            <span><strong>{item.name}:</strong> {item.purpose} Information: {item.data.join(", ")}. Kept: {item.retention} Shared with: {item.recipients.join(", ")}.</span>
          </label>
        ))}
        <p className="text-sm">{WITHDRAWAL_TEXT} Read the full <Link className="text-accent" href="/privacy">privacy notice</Link>.</p>
        <div className="flex flex-wrap gap-2 border-t border-line pt-4">
          <button className="btn" type="button" onClick={() => void decide("accept")}>Accept</button>
          <button className="btn secondary" type="button" onClick={() => void decide("decline")}>Decline</button>
        </div>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-3xl font-semibold">Privacy</h1>
      <p className="text-sm text-muted">You accepted privacy notice version {state.noticeVersion} on {when(state.decidedAt)}. <Link className="text-accent" href="/privacy">Read the notice</Link>.</p>
      {error ? <ErrorState message={error} /> : null}
      {message ? <p className="banner-ok">{message}</p> : null}
      <div className="panel space-y-3 p-5">
        <h2 className="font-semibold">Your consents</h2>
        <p className="text-sm text-muted">Untick an item to withdraw your consent. We stop that activity right away.</p>
        {state.consents.map((item) => (
          <label key={item.id} className="flex gap-2 text-sm">
            <input type="checkbox" checked={item.granted} onChange={(event) => void change("consents", item.id, event.target.checked)} />
            <span><strong>{activity(item.id).name}</strong> · {item.granted ? `given ${when(item.at)}` : "not given"}</span>
          </label>
        ))}
      </div>
      <div className="panel space-y-3 p-5">
        <h2 className="font-semibold">Restrict processing</h2>
        <p className="text-sm text-muted">Tick an activity to object to it. It stops for your account until you untick it.</p>
        {state.restrictions.map((item) => (
          <label key={item.id} className="flex gap-2 text-sm">
            <input type="checkbox" checked={item.restricted} onChange={(event) => void change("restrictions", item.id, event.target.checked)} />
            <span><strong>{activity(item.id).name}</strong> · {item.restricted ? `restricted ${when(item.at)}` : "not restricted"}</span>
          </label>
        ))}
      </div>
      <div className="panel space-y-2 p-5">
        <h2 className="font-semibold">What we may do with your information now</h2>
        <ul className="space-y-1 text-sm">
          {state.activities.map((item) => <li key={item.id}>{item.allowed ? "Allowed" : "Stopped"} · {activity(item.id).name}</li>)}
        </ul>
      </div>
      <div className="panel space-y-2 p-5">
        <h2 className="font-semibold">Your recent decisions</h2>
        <ol className="space-y-1 text-sm">
          {state.history.map((entry) => <li key={entry.id}>{when(entry.at)} · {entry.action.replace("_", " ")} {entry.items.length ? `(${entry.items.map((id) => activity(id as ActivityId).name).join(", ")})` : ""} · notice {entry.noticeVersion}</li>)}
        </ol>
      </div>
    </section>
  );
}

export default function PrivacyPage() {
  return <Suspense><PrivacyCenter /></Suspense>;
}
