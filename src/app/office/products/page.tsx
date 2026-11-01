"use client";

import { FormEvent, useEffect, useState } from "react";
import { ErrorState, LoadingState } from "@/components/states";
import { apiSend } from "@/lib/api-client";

interface Row { product: { id: string; name: string; category: string; active: boolean; description: string }; minPrice: number }

export default function ProductsOffice() {
  const [rows, setRows] = useState<Row[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [q, setQ] = useState("");
  const [ready, setReady] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    fetch("/api/catalog").then(async (response) => {
      const body = await response.json();
      if (!active) return;
      if (!response.ok) setError(body.error ?? "Could not load products.");
      else {
        setRows(body.products);
        setNextCursor(body.nextCursor ?? null);
      }
      setReady(true);
    });
    return () => {
      active = false;
    };
  }, [reloadKey]);

  async function loadMore() {
    if (!nextCursor) return;
    const response = await fetch(`/api/catalog?cursor=${encodeURIComponent(nextCursor)}`);
    const body = await response.json();
    if (!response.ok) setError(body.error ?? "Could not load more products.");
    else {
      setRows((current) => [...current, ...body.products]);
      setNextCursor(body.nextCursor ?? null);
    }
  }

  // Product update e-mails go only to customers who opted in (checked on the server when sending).
  async function announce(productId: string) {
    setError("");
    setMessage("");
    const response = await apiSend(`/api/office/products/${productId}/announce`, { method: "POST", headers: { "Content-Type": "application/json" } });
    const body = await response.json();
    if (!response.ok) setError(body.error ?? "Could not send the product update.");
    else setMessage(`Product update sent to ${body.sent} customer(s) who opted in.`);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const response = await apiSend("/api/office/products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.get("name"),
        description: form.get("description"),
        category: form.get("category"),
        priceCents: Math.round(Number(form.get("price")) * 100),
        active: true,
      }),
    });
    const body = await response.json();
    if (!response.ok) setError(body.error ?? "Could not save the product.");
    else setReloadKey((key) => key + 1);
  }

  if (!ready) return <LoadingState label="Loading catalog office..." />;
  const visible = rows.filter((row) => row.product.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <section className="grid gap-6 lg:grid-cols-[1fr_280px]">
      <div>
        <h1 className="text-3xl font-semibold">Products</h1>
        <input className="field mt-3" placeholder="Filter products" value={q} onChange={(event) => setQ(event.target.value)} />
        {error ? <div className="mt-3"><ErrorState message={error} /></div> : null}
        {message ? <p className="banner-ok mt-3">{message}</p> : null}
        <div className="mt-4 space-y-2">
          {visible.map((row) => (
            <article key={row.product.id} className="panel flex items-center justify-between gap-3 p-3">
              <div><strong>{row.product.name}</strong><p className="text-sm text-muted">{row.product.category} · ${(row.minPrice / 100).toFixed(2)}</p></div>
              <button className="btn secondary" type="button" onClick={() => void announce(row.product.id)}>E-mail update</button>
            </article>
          ))}
        </div>
        {nextCursor ? <button className="btn secondary mt-3" type="button" onClick={() => void loadMore()}>Load more</button> : null}
      </div>
      <form className="panel space-y-2 p-4" onSubmit={(event) => void submit(event)}>
        <h2 className="font-semibold">Add product</h2>
        <input className="field" name="name" placeholder="Name" required />
        <input className="field" name="category" placeholder="Category" required />
        <textarea className="field" name="description" placeholder="Description" required />
        <input className="field" name="price" type="number" min="1" step="0.01" placeholder="Price" required />
        <button className="btn">Save</button>
      </form>
    </section>
  );
}
