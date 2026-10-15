"use client";

import { useEffect, useState } from "react";
import { ErrorState, LoadingState } from "@/components/states";
import type { DeliveryStatus, Order } from "@/lib/types";

export default function OfficeOrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [role, setRole] = useState("");

  async function load() {
    const [ordersResponse, session] = await Promise.all([fetch("/api/office/orders"), fetch("/api/session")]);
    const body = await ordersResponse.json();
    if (!ordersResponse.ok) setError(body.error ?? "Could not load orders.");
    else setOrders(body);
    if (session.ok) setRole((await session.json()).user?.role ?? "");
  }
  useEffect(() => { void load(); }, []);

  async function deliver(orderId: string, status: DeliveryStatus) {
    const response = await fetch(`/api/office/orders/${orderId}/delivery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, trackingNumber: `1ZACME${Date.now().toString().slice(-6)}` }),
    });
    const body = await response.json();
    if (!response.ok) setError(body.error ?? "Could not update delivery.");
    else void load();
  }

  if (orders.length === 0 && !error) return <LoadingState label="Loading orders..." />;
  return (
    <section className="space-y-3">
      <h1 className="text-3xl font-semibold">Orders</h1>
      <input className="field" placeholder="Search order number" value={q} onChange={(event) => setQ(event.target.value)} />
      {error ? <ErrorState message={error} /> : null}
      {orders.filter((order) => order.number.includes(q.toUpperCase())).slice(0, 40).map((order) => (
        <article key={order.id} className="panel flex flex-wrap items-center justify-between gap-3 p-4">
          <div>
            <strong>{order.number}</strong>
            <p className="text-sm text-muted">Payment {order.paymentStatus} · Delivery {order.deliveryStatus}</p>
          </div>
          {role === "warehouse" || role === "administrator" ? (
            <select className="field w-auto" value={order.deliveryStatus} onChange={(event) => void deliver(order.id, event.target.value as DeliveryStatus)}>
              {["pending", "processing", "shipped", "out_for_delivery", "delivered", "cancelled", "return_requested", "returned"].map((status) => <option key={status}>{status}</option>)}
            </select>
          ) : <span className="text-sm">{order.deliveryStatus}</span>}
        </article>
      ))}
    </section>
  );
}
