"use client";

import { useEffect, useState } from "react";
import { ErrorState, LoadingState } from "@/components/states";
import type { AppEvent, PaymentScenario } from "@/lib/types";

export default function ScenariosPage() {
  const [scenario, setScenario] = useState<PaymentScenario>("approved");
  const [challenge, setChallenge] = useState<"approved" | "declined">("approved");
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [ready, setReady] = useState(false);

  async function load() {
    const response = await fetch("/api/scenarios");
    const body = await response.json();
    if (!response.ok) setError(body.error ?? "Only administrators can open scenarios.");
    else {
      setScenario(body.settings.paymentScenario);
      setChallenge(body.settings.authChallengeResult);
      setEvents(body.events);
    }
    setReady(true);
  }
  useEffect(() => { void load(); }, []);

  async function act(action: "advance" | "reset" | "settings") {
    setError("");
    const response = await fetch("/api/scenarios", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, paymentScenario: scenario, authChallengeResult: challenge }),
    });
    const body = await response.json();
    if (!response.ok) setError(body.error ?? "Could not update the simulation.");
    else {
      setMessage(action === "reset" ? "Demo data reset." : action === "advance" ? `Advanced ${body.moved ?? 0} shipments.` : "Scenario saved.");
      void load();
    }
  }

  if (!ready) return <LoadingState label="Loading scenarios..." />;
  return (
    <section className="space-y-4">
      <h1 className="text-3xl font-semibold">Simulation</h1>
      <p className="text-muted">Choose a payment outcome, advance deliveries, inspect events, or reset the forty products and sixty orders.</p>
      {error ? <ErrorState message={error} /> : null}
      {message ? <p className="banner-ok">{message}</p> : null}
      <div className="panel grid gap-3 p-4 md:grid-cols-2">
        <label>Default payment outcome
          <select className="field mt-1" value={scenario} onChange={(event) => setScenario(event.target.value as PaymentScenario)}>
            <option value="approved">Approved</option>
            <option value="declined">Declined</option>
            <option value="authentication_required">Authentication required</option>
            <option value="timeout">Timeout</option>
          </select>
        </label>
        <label>Authentication challenge result
          <select className="field mt-1" value={challenge} onChange={(event) => setChallenge(event.target.value as "approved" | "declined")}>
            <option value="approved">Approve</option>
            <option value="declined">Decline</option>
          </select>
        </label>
        <div className="flex flex-wrap gap-2 md:col-span-2">
          <button className="btn" type="button" onClick={() => void act("settings")}>Save scenario</button>
          <button className="btn secondary" type="button" onClick={() => void act("advance")}>Advance shipments</button>
          <button className="btn danger" type="button" onClick={() => void act("reset")}>Reset demo data</button>
        </div>
      </div>
      <ol className="space-y-2">
        {events.map((event) => <li key={event.id} className="panel p-3 text-sm"><strong>{event.type}</strong> · {event.message}</li>)}
      </ol>
    </section>
  );
}
