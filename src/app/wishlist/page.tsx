"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatMoney } from "@/lib/money";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";

export default function WishlistPage() {
  const [rows, setRows] = useState<{ product: { name: string; slug: string }; variant: { id: string; label: string; priceCents: number } }[]>([]);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    fetch("/api/wishlist").then(async (response) => {
      const body = await response.json();
      if (!response.ok) setError(body.error ?? "Sign in to use the wishlist.");
      else setRows(body);
      setReady(true);
    });
  }, []);

  if (!ready) return <LoadingState label="Loading wishlist..." />;
  return (
    <section className="space-y-4">
      <h1 className="text-3xl font-semibold">Wishlist</h1>
      {error ? <ErrorState message={error} /> : null}
      {rows.length === 0 && !error ? <EmptyState title="Nothing saved" body="Open a product and choose Wishlist." /> : null}
      {rows.map((row) => (
        <Link key={row.variant.id} href={`/product/${row.product.slug}`} className="panel block p-4">
          <strong>{row.product.name}</strong>
          <p className="text-sm text-muted">{row.variant.label} · {formatMoney(row.variant.priceCents)}</p>
        </Link>
      ))}
    </section>
  );
}
