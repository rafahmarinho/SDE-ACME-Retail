import { ProductGrid } from "@/components/product-grid";

export const dynamic = "force-dynamic";

export default async function CatalogPage({ searchParams }: { searchParams: Promise<{ q?: string; category?: string }> }) {
  const params = await searchParams;
  const title = params.q ? `Results for “${params.q}”` : params.category ? params.category : "Catalog";
  return <ProductGrid title={title} query={params} />;
}
