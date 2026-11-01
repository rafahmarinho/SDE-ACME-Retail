"use client";

import { FormEvent, useEffect, useState } from "react";
import { ErrorState, LoadingState } from "@/components/states";
import { apiSend } from "@/lib/api-client";

interface Row { id: string; sku: string; productName: string; label: string; stock: number; reserved: number; available: number }

export default function InventoryPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);

  // Filtering and paging run on the server.
  const params = new URLSearchParams({ limit: "100" });
  if (query) params.set("q", query);
  const requestKey = `${params.toString()}#${reloadKey}`;

  useEffect(() => {
    let active = true;
    fetch(`/api/office/inventory?${requestKey.split("#")[0]}`).then(async (response) => {
      const body = await response.json();
      if (!active) return;
      if (!response.ok) setError(body.error ?? "Could not load inventory.");
      else {
        setRows(body.items);
        setNextCursor(body.nextCursor);
      }
      setLoadedKey(requestKey);
    });
    return () => {
      active = false;
    };
  }, [requestKey]);

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setQuery(q.trim().slice(0, 60));
  }

  async function loadMore() {
    if (!nextCursor) return;
    const response = await fetch(`/api/office/inventory?${requestKey.split("#")[0]}&cursor=${encodeURIComponent(nextCursor)}`);
    const body = await response.json();
    if (!response.ok) setError(body.error ?? "Could not load more inventory.");
    else {
      setRows((current) => [...current, ...body.items]);
      setNextCursor(body.nextCursor);
    }
  }

  async function adjust(variantId: string, delta: number) {
    const response = await apiSend("/api/office/inventory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variantId, delta }),
    });
    const body = await response.json();
    if (!response.ok) setError(body.error ?? "Could not adjust stock.");
    else setReloadKey((key) => key + 1);
  }

  if (loadedKey === null) return <LoadingState label="Loading inventory..." />;
  return (
    <section className="space-y-3">
      <h1 className="text-3xl font-semibold">Inventory</h1>
      <form className="flex gap-2" onSubmit={search} role="search">
        <input className="field" placeholder="Filter SKU or product" value={q} onChange={(event) => setQ(event.target.value)} aria-label="Filter SKU or product" />
        <button className="btn secondary">Filter</button>
      </form>
      {error ? <ErrorState message={error} /> : null}
      <div className="overflow-auto">
        <table className="w-full text-left text-sm">
          <thead><tr><th>SKU</th><th>Product</th><th>Stock</th><th>Reserved</th><th>Available</th><th></th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-line">
                <td>{row.sku}</td><td>{row.productName} · {row.label}</td><td>{row.stock}</td><td>{row.reserved}</td><td>{row.available}</td>
                <td className="space-x-2 py-2"><button className="btn secondary" type="button" onClick={() => void adjust(row.id, 1)}>+1</button><button className="btn secondary" type="button" onClick={() => void adjust(row.id, -1)}>-1</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {nextCursor ? <button className="btn secondary" type="button" onClick={() => void loadMore()}>Load more</button> : null}
    </section>
  );
}
