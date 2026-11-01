"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatMoney } from "@/lib/money";
import { ErrorState, LoadingState } from "./states";
import { Swatch } from "./swatch";

export interface CatalogCard {
  product: { slug: string; name: string; category: string; imageHue: number; rating: number };
  minPrice: number;
  stock: number;
}

export function ProductGrid({
  title,
  query,
}: {
  title: string;
  query?: { q?: string; category?: string };
}) {
  const [rows, setRows] = useState<CatalogCard[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [sort, setSort] = useState("featured");
  const [inStock, setInStock] = useState(false);
  const [max, setMax] = useState("");

  const params = new URLSearchParams();
  if (query?.q) params.set("q", query.q);
  if (query?.category) params.set("category", query.category);
  if (sort) params.set("sort", sort);
  if (inStock) params.set("inStock", "1");
  if (max) params.set("max", String(Math.round(Number(max) * 100)));
  const requestKey = params.toString();
  const loading = loadedKey !== requestKey;

  useEffect(() => {
    let active = true;
    fetch(`/api/catalog?${requestKey}`)
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Could not load the catalog.");
        if (!active) return;
        setRows(body.products);
        setNextCursor(body.nextCursor ?? null);
        setCategories(body.categories);
        setError("");
      })
      .catch((reason: Error) => {
        if (active) setError(reason.message);
      })
      .finally(() => {
        if (active) setLoadedKey(requestKey);
      });
    return () => {
      active = false;
    };
  }, [requestKey]);

  // The catalog is paginated on the server; further pages are appended on request.
  async function loadMore() {
    if (!nextCursor) return;
    const response = await fetch(`/api/catalog?${requestKey}${requestKey ? "&" : ""}cursor=${encodeURIComponent(nextCursor)}`);
    const body = await response.json();
    if (!response.ok) setError(body.error ?? "Could not load more products.");
    else {
      setRows((current) => [...current, ...body.products]);
      setNextCursor(body.nextCursor ?? null);
    }
  }

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-accent">ACME Retail</p>
          <h1 className="text-3xl font-semibold">{title}</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <select className="field w-auto" value={sort} onChange={(event) => setSort(event.target.value)} aria-label="Sort products">
            <option value="featured">Featured</option>
            <option value="price_asc">Price: low to high</option>
            <option value="price_desc">Price: high to low</option>
            <option value="name">Name</option>
          </select>
          <input className="field w-32" inputMode="decimal" placeholder="Max price" value={max} onChange={(event) => setMax(event.target.value)} aria-label="Maximum price" />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={inStock} onChange={(event) => setInStock(event.target.checked)} /> In stock</label>
        </div>
      </div>
      <div className="flex gap-2 overflow-auto text-sm">
        <Link className="panel px-3 py-1" href="/catalog">All</Link>
        {categories.map((category) => (
          <Link key={category} className="panel px-3 py-1" href={`/catalog?category=${category}`}>{category}</Link>
        ))}
      </div>
      {error ? <ErrorState message={error} /> : null}
      {loading ? <LoadingState label="Loading products..." /> : null}
      {!loading && rows.length === 0 ? <p className="text-muted">No products match those filters.</p> : null}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {rows.map((row) => (
          <Link key={row.product.slug} href={`/product/${row.product.slug}`} className="panel p-3 transition hover:-translate-y-0.5">
            <Swatch hue={row.product.imageHue} name={row.product.category} />
            <h2 className="mt-3 font-semibold">{row.product.name}</h2>
            <p className="text-sm text-muted">{row.stock > 0 ? `${row.stock} available` : "Out of stock"} · {row.product.rating.toFixed(1)}</p>
            <p className="mt-1 font-semibold text-accent">{formatMoney(row.minPrice)}</p>
          </Link>
        ))}
      </div>
      {!loading && nextCursor ? <button className="btn secondary" type="button" onClick={() => void loadMore()}>Load more</button> : null}
    </section>
  );
}
