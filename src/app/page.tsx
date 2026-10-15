import { ProductGrid } from "@/components/product-grid";

export const dynamic = "force-dynamic";

export default function HomePage() {
  return (
    <div className="space-y-8">
      <section className="panel grid gap-6 p-8 md:grid-cols-[1.4fr_1fr]">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-accent">Everyday goods, clearly priced</p>
          <h1 className="mt-2 text-4xl font-semibold tracking-tight">The house store for practical things.</h1>
          <p className="mt-3 max-w-xl text-muted">Browse forty products, save a wishlist, and check out with illustrative shipping and tax. Payments are simulated and never move real money.</p>
        </div>
        <div className="grid content-end gap-2 text-sm">
          <p className="panel p-4">Free standard shipping on orders over $75.</p>
          <p className="panel p-4">Coupons: WELCOME10, SAVE5, FREESHIP.</p>
        </div>
      </section>
      <ProductGrid title="Featured and in season" />
    </div>
  );
}
