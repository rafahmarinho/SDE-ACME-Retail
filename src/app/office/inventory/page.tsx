"use client";

import { useEffect, useState } from "react";
import { ErrorState, LoadingState } from "@/components/states";

interface Row { id: string; sku: string; productName: string; label: string; stock: number; reserved: number; available: number }

export default function InventoryPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");

  async function load() {
    const response = await fetch("/api/office/inventory");
    const body = await response.json();
    if (!response.ok) setError(body.error ?? "Could not load inventory.");
    else setRows(body);
  }
  useEffect(() => { void load(); }, []);

  async function adjust(variantId: string, delta: number) {
    const response = await fetch("/api/office/inventory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variantId, delta }),
    });
    const body = await response.json();
    if (!response.ok) setError(body.error ?? "Could not adjust stock.");
    else void load();
  }

  if (rows.length === 0 && !error) return <LoadingState label="Loading inventory..." />;
  return (
    <section className="space-y-3">
      <h1 className="text-3xl font-semibold">Inventory</h1>
      <input className="field" placeholder="Filter SKU or product" value={q} onChange={(event) => setQ(event.target.value)} />
      {error ? <ErrorState message={error} /> : null}
      <div className="overflow-auto">
        <table className="w-full text-left text-sm">
          <thead><tr><th>SKU</th><th>Product</th><th>Stock</th><th>Reserved</th><th>Available</th><th></th></tr></thead>
          <tbody>
            {rows.filter((row) => `${row.sku} ${row.productName}`.toLowerCase().includes(q.toLowerCase())).map((row) => (
              <tr key={row.id} className="border-t border-line">
                <td>{row.sku}</td><td>{row.productName} · {row.label}</td><td>{row.stock}</td><td>{row.reserved}</td><td>{row.available}</td>
                <td className="space-x-2 py-2"><button className="btn secondary" type="button" onClick={() => void adjust(row.id, 1)}>+1</button><button className="btn secondary" type="button" onClick={() => void adjust(row.id, -1)}>-1</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
