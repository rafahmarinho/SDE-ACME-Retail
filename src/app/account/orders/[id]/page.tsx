"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { formatMoney } from "@/lib/money";
import { ErrorState, LoadingState } from "@/components/states";
import { browserSupabase } from "@/lib/supabase/browser";
import type { AppEvent, Order } from "@/lib/types";
import { apiSend } from "@/lib/api-client";

export default function TrackingPage() {
  const params = useParams<{ id: string }>();
  const [order, setOrder] = useState<Order | null>(null);
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    // Background refreshes are marked passive so they do not extend the idle session timeout.
    const load = (passive = false) =>
      fetch(`/api/orders/${params.id}`, passive ? { headers: { "X-Acme-Passive": "1" } } : undefined).then(async (response) => {
        const body = await response.json();
        if (!active) return;
        if (!response.ok) setError(body.error ?? "Could not load tracking.");
        else {
          setOrder(body.order);
          setEvents(body.events);
        }
      });
    void load();
    const timer = setInterval(() => void load(true), 4000);
    const supabase = browserSupabase();
    const channel = supabase
      ?.channel(`order-${params.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "order_feed", filter: `id=eq.${params.id}` }, () => void load(true))
      .subscribe();
    return () => {
      active = false;
      clearInterval(timer);
      if (channel) void supabase?.removeChannel(channel);
    };
  }, [params.id, reloadKey]);

  async function cancel() {
    const response = await apiSend(`/api/orders/${params.id}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" } });
    const body = await response.json();
    if (!response.ok) setError(body.error ?? "Could not cancel the order.");
    else setReloadKey((key) => key + 1);
  }

  if (!order && !error) return <LoadingState label="Loading tracking..." />;
  if (!order) return <ErrorState message={error} />;
  return (
    <section className="grid gap-6 md:grid-cols-2">
      <div className="space-y-3">
        <h1 className="text-3xl font-semibold">{order.number}</h1>
        {error ? <ErrorState message={error} /> : null}
        <p className="panel p-4">Payment: <strong>{order.paymentStatus}</strong></p>
        <p className="panel p-4">Delivery: <strong>{order.deliveryStatus}</strong></p>
        <p className="text-sm text-muted">{order.carrier ?? "Carrier assigned after shipment"} {order.trackingNumber ?? ""}</p>
        <p>Saved total {formatMoney(order.totalCents)} · tax {formatMoney(order.taxCents)} · shipping {formatMoney(order.shippingCents)}</p>
        <ul>{order.items.map((item) => <li key={item.sku}>{item.productName} ({item.label}) × {item.qty} at {formatMoney(item.unitPriceCents)}</li>)}</ul>
        <button className="btn danger" type="button" onClick={() => void cancel()}>Cancel if not shipped</button>
      </div>
      <ol className="panel space-y-3 p-4">
        {events.map((event) => <li key={event.id}><strong>{event.type}</strong><p className="text-sm text-muted">{event.message}</p></li>)}
        {events.length === 0 ? <li className="text-sm text-muted">No events yet. This page refreshes automatically.</li> : null}
      </ol>
    </section>
  );
}
