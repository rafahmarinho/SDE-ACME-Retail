"use client";

import { FormEvent, useEffect, useState } from "react";
import { ErrorState, LoadingState } from "@/components/states";
import type { Order, ReturnRequest } from "@/lib/types";

export default function ReturnsPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [returns, setReturns] = useState<ReturnRequest[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [ready, setReady] = useState(false);

  async function load() {
    const [orderResponse, returnResponse] = await Promise.all([fetch("/api/orders"), fetch("/api/returns")]);
    if (!orderResponse.ok) setError("Sign in to request a return.");
    else setOrders(await orderResponse.json());
    if (returnResponse.ok) setReturns(await returnResponse.json());
    setReady(true);
  }

  useEffect(() => { void load(); }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget);
    const file = form.get("photo");
    let photoName: string | null = null;
    if (file instanceof File && file.size > 0) {
      const upload = new FormData();
      upload.set("file", file);
      const uploaded = await fetch("/api/uploads", { method: "POST", body: upload });
      const uploadBody = await uploaded.json();
      if (!uploaded.ok) {
        setError(uploadBody.error ?? "Could not upload the photo.");
        return;
      }
      photoName = uploadBody.name;
    }
    const order = orders.find((item) => item.id === form.get("orderId"));
    const response = await fetch("/api/returns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderId: form.get("orderId"),
        note: form.get("note"),
        photoName,
        items: order ? [{ variantId: order.items[0].variantId, qty: 1, reason: String(form.get("reason")) }] : [],
      }),
    });
    const body = await response.json();
    if (!response.ok) setError(body.error ?? "Could not create the return.");
    else {
      setMessage("Return requested. Delivery status is now separate from payment status.");
      void load();
    }
  }

  if (!ready) return <LoadingState label="Loading returns..." />;
  const eligible = orders.filter((order) => ["shipped", "out_for_delivery", "delivered"].includes(order.deliveryStatus));
  return (
    <section className="grid gap-6 md:grid-cols-2">
      <form className="panel space-y-3 p-5" onSubmit={(event) => void submit(event)}>
        <h1 className="text-2xl font-semibold">Returns</h1>
        {error ? <ErrorState message={error} /> : null}
        {message ? <p className="banner-ok">{message}</p> : null}
        <select className="field" name="orderId" required>
          <option value="">Select an order</option>
          {eligible.map((order) => <option key={order.id} value={order.id}>{order.number}</option>)}
        </select>
        <input className="field" name="reason" placeholder="Reason" required minLength={3} />
        <textarea className="field" name="note" placeholder="Notes" />
        <input className="field" type="file" name="photo" accept="image/png,image/jpeg,image/webp" />
        <button className="btn">Request return</button>
      </form>
      <div className="space-y-3">
        {returns.map((item) => <article key={item.id} className="panel p-4"><strong>{item.status}</strong><p className="text-sm text-muted">{item.note || item.items[0]?.reason}</p></article>)}
      </div>
    </section>
  );
}
