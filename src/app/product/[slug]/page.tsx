"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { formatMoney } from "@/lib/money";
import { ErrorState, LoadingState } from "@/components/states";
import { Swatch } from "@/components/swatch";

interface VariantView {
  id: string;
  label: string;
  priceCents: number;
  available: number;
  options: Record<string, string>;
}

export default function ProductPage() {
  const params = useParams<{ slug: string }>();
  const [product, setProduct] = useState<{ name: string; description: string; category: string; imageHue: number } | null>(null);
  const [variants, setVariants] = useState<VariantView[]>([]);
  const [selected, setSelected] = useState("");
  const [qty, setQty] = useState(1);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/products/${params.slug}`)
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Product not found.");
        setProduct(body.product);
        setVariants(body.variants);
        setSelected(body.variants[0]?.id ?? "");
      })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  }, [params.slug]);

  const variant = variants.find((item) => item.id === selected);

  async function add(kind: "cart" | "wishlist") {
    setError("");
    setMessage("");
    const response = await fetch(kind === "cart" ? "/api/cart" : "/api/wishlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(kind === "cart" ? { variantId: selected, qty } : { variantId: selected }),
    });
    const body = await response.json();
    if (!response.ok) setError(body.error ?? "Could not update your selection.");
    else {
      setMessage(kind === "cart" ? "Added to cart." : "Wishlist updated.");
      if (kind === "cart") window.dispatchEvent(new Event("acme-cart"));
    }
  }

  if (loading) return <LoadingState label="Loading product..." />;
  if (!product) return <ErrorState message={error || "Product not found."} />;

  return (
    <div className="grid gap-8 md:grid-cols-2">
      <Swatch hue={product.imageHue} name={product.category} />
      <div className="space-y-4">
        <p className="text-sm text-accent">{product.category}</p>
        <h1 className="text-3xl font-semibold">{product.name}</h1>
        <p className="text-muted">{product.description}</p>
        <p className="text-2xl font-semibold">{variant ? formatMoney(variant.priceCents) : ""}</p>
        <label className="block text-sm">Option
          <select className="field mt-1" value={selected} onChange={(event) => setSelected(event.target.value)}>
            {variants.map((item) => (
              <option key={item.id} value={item.id}>{item.label} · {item.available} available</option>
            ))}
          </select>
        </label>
        <label className="block text-sm">Quantity
          <input className="field mt-1 w-24" type="number" min={1} max={10} value={qty} onChange={(event) => setQty(Number(event.target.value))} />
        </label>
        {error ? <ErrorState message={error} /> : null}
        {message ? <p className="banner-ok">{message}</p> : null}
        <div className="flex gap-2">
          <button className="btn" type="button" disabled={!variant || variant.available < 1} onClick={() => void add("cart")}>Add to cart</button>
          <button className="btn secondary" type="button" onClick={() => void add("wishlist")}>Wishlist</button>
        </div>
      </div>
    </div>
  );
}
