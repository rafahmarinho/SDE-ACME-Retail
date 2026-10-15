"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatMoney } from "@/lib/money";
import { ErrorState, LoadingState } from "@/components/states";

interface CartResponse {
  items: { qty: number; lineCents: number; product: { name: string; slug: string }; variant: { id: string; label: string } }[];
  subtotalCents: number;
}

export default function CartPage() {
  const [cart, setCart] = useState<CartResponse | null>(null);
  const [error, setError] = useState("");

  async function load() {
    const response = await fetch("/api/cart");
    const body = await response.json();
    if (!response.ok) setError(body.error ?? "Could not load the cart.");
    else setCart(body);
  }

  useEffect(() => { void load(); }, []);

  async function update(variantId: string, qty: number) {
    const response = await fetch("/api/cart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variantId, qty }),
    });
    const body = await response.json();
    if (!response.ok) setError(body.error ?? "Could not update the cart.");
    else {
      setCart(body);
      window.dispatchEvent(new Event("acme-cart"));
    }
  }

  if (!cart && !error) return <LoadingState label="Loading cart..." />;
  return (
    <section className="space-y-4">
      <h1 className="text-3xl font-semibold">Cart</h1>
      {error ? <ErrorState message={error} /> : null}
      {cart?.items.length === 0 ? <p className="text-muted">Your cart is empty. <Link href="/catalog">Browse the catalog</Link>.</p> : null}
      {cart?.items.map((item) => (
        <div key={item.variant.id} className="panel flex items-center justify-between p-4">
          <div>
            <Link href={`/product/${item.product.slug}`} className="font-semibold">{item.product.name}</Link>
            <p className="text-sm text-muted">{item.variant.label}</p>
          </div>
          <div className="flex items-center gap-3">
            <input className="field w-20" type="number" min={0} max={10} value={item.qty} onChange={(event) => void update(item.variant.id, Number(event.target.value))} />
            <strong>{formatMoney(item.lineCents)}</strong>
          </div>
        </div>
      ))}
      {cart && cart.items.length > 0 ? (
        <div className="flex items-center justify-between">
          <p className="text-lg font-semibold">Subtotal {formatMoney(cart.subtotalCents)}</p>
          <Link className="btn" href="/checkout">Checkout</Link>
        </div>
      ) : null}
    </section>
  );
}
