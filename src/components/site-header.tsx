"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import type { PublicUser } from "@/lib/types";
import type { Permission } from "@/lib/policy";
import { formatMoney } from "@/lib/money";
import { apiSend, rememberCsrfToken } from "@/lib/api-client";

type CartItem = { qty: number; product: { name: string; slug: string }; variant: { id: string; label: string; priceCents: number } };

// Navigation only mirrors the permissions the server returns; the server enforces them.
const officeLinks: { permission: Permission; href: string; label: string }[] = [
  { permission: "catalog.manage", href: "/office/products", label: "Products" },
  { permission: "inventory.view", href: "/office/inventory", label: "Inventory" },
  { permission: "orders.view", href: "/office/orders", label: "Orders" },
  { permission: "refunds.view", href: "/office/refunds", label: "Refunds" },
  { permission: "scenarios.manage", href: "/office/scenarios", label: "Scenarios" },
  { permission: "events.view", href: "/office/audit", label: "Audit" },
];

export function SiteHeader() {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<PublicUser | null>(null);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [cart, setCart] = useState<{ items: CartItem[]; subtotalCents: number }>({ items: [], subtotalCents: 0 });
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const onCart = () => setRefreshKey((key) => key + 1);
    window.addEventListener("acme-cart", onCart);
    window.addEventListener("focus", onCart);
    return () => {
      window.removeEventListener("acme-cart", onCart);
      window.removeEventListener("focus", onCart);
    };
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([fetch("/api/session"), fetch("/api/cart")]).then(async ([session, cartResponse]) => {
      const sessionBody = session.ok ? await session.json() : null;
      const cartBody = cartResponse.ok ? await cartResponse.json() : null;
      if (!active) return;
      if (sessionBody) {
        rememberCsrfToken(sessionBody.csrfToken);
        setUser(sessionBody.user);
        setPermissions(sessionBody.permissions ?? []);
      }
      if (cartBody) setCart(cartBody);
    });
    return () => {
      active = false;
    };
  }, [pathname, refreshKey]);

  async function signOut() {
    await apiSend("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" } });
    setUser(null);
    setPermissions([]);
    router.push("/");
  }

  function search(event: FormEvent) {
    event.preventDefault();
    router.push(`/catalog?q=${encodeURIComponent(query)}`);
  }

  async function updateQty(variantId: string, qty: number) {
    setError("");
    const response = await apiSend("/api/cart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variantId, qty }),
    });
    const body = await response.json();
    if (!response.ok) setError(body.error ?? "Could not update the cart.");
    else setCart(body);
  }

  const links = user ? officeLinks.filter((link) => permissions.includes(link.permission)) : [];

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
        <Link href="/" className="text-lg font-semibold tracking-tight">ACME Retail</Link>
        <form onSubmit={search} className="hidden min-w-0 flex-1 md:block" role="search">
          <input className="field" placeholder="Search products" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search products" />
        </form>
        <nav className="ml-auto flex items-center gap-3 text-sm">
          <Link href="/catalog">Catalog</Link>
          {!user || permissions.includes("orders.purchase") ? <Link href="/wishlist">Wishlist</Link> : null}
          {user ? <Link href="/account/orders">Orders</Link> : <Link href="/login">Sign in</Link>}
          {user ? <button className="btn secondary" type="button" onClick={() => void signOut()}>Sign out</button> : null}
          <button className="btn secondary" type="button" onClick={() => setOpen(true)}>Cart ({cart.items.reduce((sum, item) => sum + item.qty, 0)})</button>
        </nav>
      </div>
      <div className="mx-auto flex max-w-6xl gap-4 overflow-auto px-4 pb-3 text-sm text-muted">
        {["Apparel", "Home", "Kitchen", "Electronics", "Outdoors", "Beauty", "Grocery"].map((category) => (
          <Link key={category} href={`/catalog?category=${category}`}>{category}</Link>
        ))}
        {links.map((link) => (
          <Link key={link.href} href={link.href} className="font-semibold text-accent">{link.label}</Link>
        ))}
      </div>
      {open ? (
        <div className="fixed inset-0 z-40 bg-black/30" onClick={() => setOpen(false)}>
          <aside className="ml-auto flex h-full w-full max-w-md flex-col bg-surface p-5" onClick={(event) => event.stopPropagation()} aria-label="Cart">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Your cart</h2>
              <button className="btn secondary" type="button" onClick={() => setOpen(false)}>Close</button>
            </div>
            {error ? <p className="banner-error mt-3">{error}</p> : null}
            <div className="mt-4 flex-1 space-y-3 overflow-auto">
              {cart.items.length === 0 ? <p className="text-sm text-muted">Your cart is empty.</p> : null}
              {cart.items.map((item) => (
                <div key={item.variant.id} className="flex items-center justify-between gap-3 border-b border-line pb-3">
                  <div>
                    <Link href={`/product/${item.product.slug}`} className="font-medium">{item.product.name}</Link>
                    <p className="text-sm text-muted">{item.variant.label}</p>
                  </div>
                  <div className="text-right">
                    <p>{formatMoney(item.variant.priceCents * item.qty)}</p>
                    <input className="field mt-1 w-16" type="number" min={0} max={10} value={item.qty} onChange={(event) => void updateQty(item.variant.id, Number(event.target.value))} aria-label={`Quantity for ${item.product.name}`} />
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 space-y-3">
              <p className="flex justify-between font-semibold"><span>Subtotal</span><span>{formatMoney(cart.subtotalCents)}</span></p>
              <Link className="btn w-full" href="/cart" onClick={() => setOpen(false)}>Review cart</Link>
            </div>
          </aside>
        </div>
      ) : null}
    </header>
  );
}
