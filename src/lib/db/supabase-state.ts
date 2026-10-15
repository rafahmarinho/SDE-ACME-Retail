import type { StoreData } from "../types";
import { supabaseAdmin } from "../supabase/admin";

export async function loadSupabaseState(): Promise<StoreData | null> {
  const client = supabaseAdmin();
  if (!client) return null;
  const { data, error } = await client.from("retail_state").select("data").eq("id", 1).maybeSingle();
  if (error || !data?.data) return null;
  return data.data as StoreData;
}

export async function saveSupabaseState(state: StoreData): Promise<void> {
  const client = supabaseAdmin();
  if (!client) return;
  const { error } = await client.from("retail_state").upsert({
    id: 1,
    data: state,
    version: state.version,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error("Could not persist data to Supabase.");
  const orders = state.orders.slice(0, 200).map((order) => ({
    id: order.id,
    user_id: order.userId,
    number: order.number,
    payment_status: order.paymentStatus,
    delivery_status: order.deliveryStatus,
    updated_at: order.updatedAt,
  }));
  if (orders.length) {
    await client.from("order_feed").upsert(orders);
  }
}
