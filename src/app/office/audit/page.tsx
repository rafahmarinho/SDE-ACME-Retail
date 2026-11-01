"use client";

import { useEffect, useState } from "react";
import { ErrorState, LoadingState } from "@/components/states";

interface AuditEvent { id: string; at: string; type: string; message: string; orderId: string | null; actorId: string | null }
interface Integrity { ok: boolean; checked: number; brokenAt: string | null }

/** Read-only audit trail with the verification of its hash chain (oversight duty). */
export default function AuditPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [integrity, setIntegrity] = useState<Integrity | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/office/audit?limit=100").then(async (response) => {
      const body = await response.json();
      if (!active) return;
      if (!response.ok) setError(body.error ?? "Could not load the audit trail.");
      else {
        setEvents(body.items);
        setIntegrity(body.integrity);
        setNextCursor(body.nextCursor);
      }
      setReady(true);
    });
    return () => {
      active = false;
    };
  }, []);

  async function loadMore() {
    if (!nextCursor) return;
    const response = await fetch(`/api/office/audit?limit=100&cursor=${encodeURIComponent(nextCursor)}`);
    const body = await response.json();
    if (!response.ok) setError(body.error ?? "Could not load more events.");
    else {
      setEvents((current) => [...current, ...body.items]);
      setNextCursor(body.nextCursor);
    }
  }

  if (!ready) return <LoadingState label="Loading audit trail..." />;
  return (
    <section className="space-y-4">
      <h1 className="text-3xl font-semibold">Audit trail</h1>
      {error ? <ErrorState message={error} /> : null}
      {integrity ? (
        integrity.ok ? (
          <p className="banner-ok">Integrity verified: {integrity.checked} chained events, none changed, removed or reordered.</p>
        ) : (
          <p className="banner-error" role="alert">The audit chain is broken at event {integrity.brokenAt}. Report this to security.</p>
        )
      ) : null}
      <p className="text-sm text-muted">Read-only. Events cannot be edited or deleted; the oldest leave the trail only by the retention limit.</p>
      <ol className="space-y-2">
        {events.map((event) => (
          <li key={event.id} className="panel p-3 text-sm">
            <strong>{event.type}</strong> · {new Date(event.at).toLocaleString()}{event.actorId ? ` · ${event.actorId}` : ""}
            <p className="text-muted">{event.message}</p>
          </li>
        ))}
      </ol>
      {nextCursor ? <button className="btn secondary" type="button" onClick={() => void loadMore()}>Load more</button> : null}
    </section>
  );
}
