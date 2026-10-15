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
  const [categories, setCategories] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState("featured");
  const [inStock, setInStock] = useState(false);
  const [max, setMax] = useState("");

  useEffect(() => {
    const params = new URLSearchParams();
    if (query?.q) params.set("q", query.q);
    if (query?.category) params.set("category", query.category);
    if (sort) params.set("sort", sort);
    if (inStock) params.set("inStock", "1");
    if (max) params.set("max", String(Math.round(Number(max) * 100)));
    setLoading(true);
    fetch(`/api/catalog?${params}`)
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Could not load the catalog.");
        setRows(body.products);
        setCategories(body.categories);
        setError("");
      })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  }, [query?.q, query?.category, sort, inStock, max]);

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
    </section>
  );
}
