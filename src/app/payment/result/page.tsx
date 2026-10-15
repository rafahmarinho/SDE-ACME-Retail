"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { formatMoney } from "@/lib/money";
import { ErrorState, LoadingState } from "@/components/states";

function Result() {
  const params = useSearchParams();
  const orderId = params.get("order") ?? "";
  const [order, setOrder] = useState<{ id: string; number: string; paymentStatus: string; deliveryStatus: string; totalCents: number; items: { productName: string; unitPriceCents: number; qty: number }[] } | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function load() {
    if (!orderId) return;
    const response = await fetch(`/api/orders/${orderId}`);
    const body = await response.json();
    if (!response.ok) setError(body.error ?? "Could not load the payment result.");
    else setOrder(body.order);
  }

  useEffect(() => { void load(); }, [orderId]);

  async function authenticate() {
    const response = await fetch(`/api/orders/${orderId}/authenticate`, { method: "POST" });
    const body = await response.json();
    if (!response.ok) setError(body.error ?? "Authentication could not be completed.");
    else {
      setOrder(body);
      setMessage("Simulated authentication finished. No card data was sent.");
    }
  }

  if (!orderId) return <ErrorState message="Missing order reference." />;
  if (!order && !error) return <LoadingState label="Loading payment result..." />;
  return (
    <section className="panel space-y-4 p-6">
      <h1 className="text-3xl font-semibold">Payment result</h1>
      {error ? <ErrorState message={error} /> : null}
      {message ? <p className="banner-ok">{message}</p> : null}
      {order ? (
        <>
          <p>Order <strong>{order.number}</strong></p>
          <p>Payment status: <strong>{order.paymentStatus.replaceAll("_", " ")}</strong></p>
          <p>Delivery status: <strong>{order.deliveryStatus.replaceAll("_", " ")}</strong></p>
          <p>Amount recorded: {formatMoney(order.totalCents)}</p>
          <ul className="text-sm text-muted">
            {order.items.map((item) => <li key={item.productName}>{item.productName} · saved price {formatMoney(item.unitPriceCents)} × {item.qty}</li>)}
          </ul>
          {order.paymentStatus === "authentication_required" ? <button className="btn" type="button" onClick={() => void authenticate()}>Complete simulated authentication</button> : null}
          <Link className="btn secondary" href={`/account/orders/${order.id}`}>Track order</Link>
        </>
      ) : null}
    </section>
  );
}

export default function PaymentResultPage() {
  return <Suspense fallback={<LoadingState label="Loading payment result..." />}><Result /></Suspense>;
}
