"use client";

import { FormEvent, useEffect, useState } from "react";
import { ErrorState, LoadingState } from "@/components/states";
import type { Order, ReturnRequest } from "@/lib/types";
import { apiSend } from "@/lib/api-client";

export default function ReturnsPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [returns, setReturns] = useState<ReturnRequest[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [ready, setReady] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    // Only shipped orders can be returned; the server filters and bounds both lists.
    Promise.all([fetch("/api/orders?delivery=shipped,out_for_delivery,delivered&limit=50"), fetch("/api/returns?limit=50")]).then(async ([orderResponse, returnResponse]) => {
      const nextOrders = orderResponse.ok ? (await orderResponse.json()).items : null;
      const nextReturns = returnResponse.ok ? (await returnResponse.json()).items : null;
      if (!active) return;
      if (!nextOrders) setError("Sign in to request a return.");
      else setOrders(nextOrders);
      if (nextReturns) setReturns(nextReturns);
      setReady(true);
    });
    return () => {
      active = false;
    };
  }, [reloadKey]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget);
    const file = form.get("photo");
    let photoId: string | null = null;
    if (file instanceof File && file.size > 0) {
      const upload = new FormData();
      upload.set("file", file);
      const uploaded = await apiSend("/api/uploads", { method: "POST", headers: { "X-Requested-With": "fetch" }, body: upload });
      const uploadBody = await uploaded.json();
      if (!uploaded.ok) {
        setError(uploadBody.error ?? "Could not upload the photo.");
        return;
      }
      photoId = uploadBody.id;
    }
    const order = orders.find((item) => item.id === form.get("orderId"));
    const response = await apiSend("/api/returns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderId: form.get("orderId"),
        note: form.get("note"),
        photoId,
        items: order ? [{ variantId: order.items[0].variantId, qty: 1, reason: String(form.get("reason")) }] : [],
      }),
    });
    const body = await response.json();
    if (!response.ok) setError(body.error ?? "Could not create the return.");
    else {
      setMessage("Return requested. Delivery status is now separate from payment status.");
      setReloadKey((key) => key + 1);
    }
  }

  if (!ready) return <LoadingState label="Loading returns..." />;
  const eligible = orders;
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
