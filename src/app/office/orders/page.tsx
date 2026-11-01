"use client";

import { FormEvent, useEffect, useState } from "react";
import { ErrorState, LoadingState } from "@/components/states";
import { DELIVERY_TRANSITIONS } from "@/lib/delivery";
import type { DeliveryStatus, Order } from "@/lib/types";
import { apiSend } from "@/lib/api-client";

type OrderRow = Pick<Order, "id" | "number" | "paymentStatus" | "deliveryStatus">;

function newTrackingNumber() {
  return `1ZACME${Date.now().toString().slice(-6)}`;
}

export default function OfficeOrdersPage() {
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [canFulfil, setCanFulfil] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);

  // Search and paging run on the server (at most 100 rows per page).
  const params = new URLSearchParams({ limit: "50" });
  if (query) params.set("q", query);
  const requestKey = `${params.toString()}#${reloadKey}`;

  useEffect(() => {
    let active = true;
    const search = requestKey.split("#")[0];
    Promise.all([fetch(`/api/office/orders?${search}`), fetch("/api/session")]).then(async ([ordersResponse, session]) => {
      const body = await ordersResponse.json();
      const permissions: string[] = session.ok ? ((await session.json()).permissions ?? []) : [];
      if (!active) return;
      if (!ordersResponse.ok) setError(body.error ?? "Could not load orders.");
      else {
        setOrders(body.items);
        setNextCursor(body.nextCursor);
        setTotal(body.total);
      }
      setCanFulfil(permissions.includes("orders.fulfil"));
      setLoadedKey(requestKey);
    });
    return () => {
      active = false;
    };
  }, [requestKey]);

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setQuery(q.toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 20));
  }

  async function loadMore() {
    if (!nextCursor) return;
    const response = await fetch(`/api/office/orders?${requestKey.split("#")[0]}&cursor=${encodeURIComponent(nextCursor)}`);
    const body = await response.json();
    if (!response.ok) setError(body.error ?? "Could not load more orders.");
    else {
      setOrders((current) => [...current, ...body.items]);
      setNextCursor(body.nextCursor);
    }
  }

  async function deliver(orderId: string, status: DeliveryStatus) {
    const response = await apiSend(`/api/office/orders/${orderId}/delivery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, trackingNumber: newTrackingNumber() }),
    });
    const body = await response.json();
    if (!response.ok) setError(body.error ?? "Could not update delivery.");
    else setReloadKey((key) => key + 1);
  }

  if (loadedKey === null) return <LoadingState label="Loading orders..." />;
  return (
    <section className="space-y-3">
      <h1 className="text-3xl font-semibold">Orders</h1>
      <form className="flex gap-2" onSubmit={search} role="search">
        <input className="field" placeholder="Search order number" value={q} onChange={(event) => setQ(event.target.value)} aria-label="Search order number" />
        <button className="btn secondary">Search</button>
      </form>
      {error ? <ErrorState message={error} /> : null}
      {orders.length === 0 ? <p className="text-sm text-muted">No orders match.</p> : null}
      {orders.map((order) => (
        <article key={order.id} className="panel flex flex-wrap items-center justify-between gap-3 p-4">
          <div>
            <strong>{order.number}</strong>
            <p className="text-sm text-muted">Payment {order.paymentStatus} · Delivery {order.deliveryStatus}</p>
          </div>
          {canFulfil && DELIVERY_TRANSITIONS[order.deliveryStatus].length > 0 ? (
            <select className="field w-auto" value={order.deliveryStatus} onChange={(event) => void deliver(order.id, event.target.value as DeliveryStatus)}>
              {[order.deliveryStatus, ...DELIVERY_TRANSITIONS[order.deliveryStatus]].map((status) => <option key={status}>{status}</option>)}
            </select>
          ) : <span className="text-sm">{order.deliveryStatus}</span>}
        </article>
      ))}
      {orders.length > 0 ? <p className="text-sm text-muted">Showing {orders.length} of {total}.</p> : null}
      {nextCursor ? <button className="btn secondary" type="button" onClick={() => void loadMore()}>Load more</button> : null}
    </section>
  );
}
