"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatMoney } from "@/lib/money";
import { ErrorState, EmptyState, LoadingState } from "@/components/states";
import type { Order } from "@/lib/types";

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [payment, setPayment] = useState("");
  const [delivery, setDelivery] = useState("");

  // Filters and paging run on the server; the page shows one bounded page at a time.
  const params = new URLSearchParams({ limit: "20" });
  if (payment) params.set("payment", payment);
  if (delivery) params.set("delivery", delivery);
  const requestKey = params.toString();

  useEffect(() => {
    let active = true;
    fetch(`/api/orders?${requestKey}`).then(async (response) => {
      const body = await response.json();
      if (!active) return;
      if (!response.ok) setError(body.error ?? "Could not load orders.");
      else {
        setOrders(body.items);
        setNextCursor(body.nextCursor);
        setTotal(body.total);
        setError("");
      }
      setLoadedKey(requestKey);
    });
    return () => {
      active = false;
    };
  }, [requestKey]);

  async function loadMore() {
    if (!nextCursor) return;
    const response = await fetch(`/api/orders?${requestKey}&cursor=${encodeURIComponent(nextCursor)}`);
    const body = await response.json();
    if (!response.ok) setError(body.error ?? "Could not load more orders.");
    else {
      setOrders((current) => [...current, ...body.items]);
      setNextCursor(body.nextCursor);
    }
  }

  if (loadedKey === null) return <LoadingState label="Loading orders..." />;
  return (
    <section className="space-y-4">
      <h1 className="text-3xl font-semibold">Orders</h1>
      <div className="flex gap-2">
        <select className="field" value={payment} onChange={(event) => setPayment(event.target.value)} aria-label="Filter by payment status">
          <option value="">All payments</option>
          {["approved", "declined", "authentication_required", "timeout", "refunded", "partially_refunded", "cancelled", "pending"].map((status) => <option key={status}>{status}</option>)}
        </select>
        <select className="field" value={delivery} onChange={(event) => setDelivery(event.target.value)} aria-label="Filter by delivery status">
          <option value="">All deliveries</option>
          {["pending", "processing", "shipped", "out_for_delivery", "delivered", "cancelled", "return_requested", "returned"].map((status) => <option key={status}>{status}</option>)}
        </select>
      </div>
      {error ? <ErrorState message={error} /> : null}
      {orders.length === 0 ? <EmptyState title="No orders" body="Orders you place will stay here after a reload." /> : null}
      {orders.map((order) => (
        <Link key={order.id} href={`/account/orders/${order.id}`} className="panel block p-4">
          <div className="flex justify-between"><strong>{order.number}</strong><span>{formatMoney(order.totalCents)}</span></div>
          <p className="text-sm text-muted">Payment: {order.paymentStatus} · Delivery: {order.deliveryStatus}</p>
        </Link>
      ))}
      {orders.length > 0 ? <p className="text-sm text-muted">Showing {orders.length} of {total}.</p> : null}
      {nextCursor ? <button className="btn secondary" type="button" onClick={() => void loadMore()}>Load more</button> : null}
    </section>
  );
}
