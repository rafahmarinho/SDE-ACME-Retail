"use client";

import { FormEvent, useEffect, useState } from "react";
import { formatMoney } from "@/lib/money";
import { ErrorState, LoadingState } from "@/components/states";
import type { Order, Refund } from "@/lib/types";

export default function RefundsPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [refunds, setRefunds] = useState<Refund[]>([]);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);

  async function load() {
    const [orderResponse, refundResponse] = await Promise.all([fetch("/api/office/orders"), fetch("/api/office/refunds")]);
    if (orderResponse.ok) setOrders(await orderResponse.json());
    else setError("You do not have access to refunds.");
    if (refundResponse.ok) setRefunds(await refundResponse.json());
    setReady(true);
  }
  useEffect(() => { void load(); }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/office/refunds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderId: form.get("orderId"),
        amountCents: Math.round(Number(form.get("amount")) * 100),
        reason: form.get("reason"),
      }),
    });
    const body = await response.json();
    if (!response.ok) setError(body.error ?? "Could not refund.");
    else void load();
  }

  if (!ready) return <LoadingState label="Loading refunds..." />;
  const payable = orders.filter((order) => order.paymentStatus === "approved" || order.paymentStatus === "partially_refunded");
  return (
    <section className="grid gap-6 md:grid-cols-2">
      <form className="panel space-y-3 p-5" onSubmit={(event) => void submit(event)}>
        <h1 className="text-2xl font-semibold">Refunds</h1>
        <p className="text-sm text-muted">Full or partial simulated refunds. Delivery status stays unchanged.</p>
        {error ? <ErrorState message={error} /> : null}
        <select className="field" name="orderId" required>
          {payable.map((order) => <option key={order.id} value={order.id}>{order.number} · {formatMoney(order.totalCents)}</option>)}
        </select>
        <input className="field" name="amount" type="number" min="0.01" step="0.01" placeholder="Amount" required />
        <input className="field" name="reason" placeholder="Reason" required />
        <button className="btn">Issue refund</button>
      </form>
      <div className="space-y-2">
        {refunds.map((refund) => <article key={refund.id} className="panel p-3">{refund.partial ? "Partial" : "Full"} {formatMoney(refund.amountCents)} · {refund.reason}</article>)}
      </div>
    </section>
  );
}
