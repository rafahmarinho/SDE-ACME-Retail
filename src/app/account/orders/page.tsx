"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatMoney } from "@/lib/money";
import { ErrorState, EmptyState, LoadingState } from "@/components/states";
import type { Order } from "@/lib/types";

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [payment, setPayment] = useState("");
  const [delivery, setDelivery] = useState("");

  useEffect(() => {
    fetch("/api/orders")
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Could not load orders.");
        setOrders(body);
      })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  }, []);

  const visible = orders.filter((order) => (!payment || order.paymentStatus === payment) && (!delivery || order.deliveryStatus === delivery));
  if (loading) return <LoadingState label="Loading orders..." />;
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
      {visible.length === 0 ? <EmptyState title="No orders" body="Orders you place will stay here after a reload." /> : null}
      {visible.map((order) => (
        <Link key={order.id} href={`/account/orders/${order.id}`} className="panel block p-4">
          <div className="flex justify-between"><strong>{order.number}</strong><span>{formatMoney(order.totalCents)}</span></div>
          <p className="text-sm text-muted">Payment: {order.paymentStatus} · Delivery: {order.deliveryStatus}</p>
        </Link>
      ))}
    </section>
  );
}
