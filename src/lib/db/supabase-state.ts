import { randomUUID } from "node:crypto";
import type { StoreData } from "../types";
import { supabaseAdmin } from "../supabase/admin";
import { AppError } from "../errors";
import { appErrorLog, dbLog } from "../security-log";
import { RESULT_CAPS } from "../query-limits";
import { feedRestrictedUsers } from "../privacy-rules";
import type { SealedText } from "../data-crypto";

/**
 * Returns the stored snapshot, null when none exists yet, and throws when the database cannot be read.
 * maybeSingle() makes the query fail instead of returning more than one row.
 */
export async function loadSupabaseState(): Promise<unknown> {
  const client = supabaseAdmin();
  if (!client) return null;
  const started = Date.now();
  const { data, error } = await client.from("retail_state").select("data").eq("id", 1).maybeSingle();
  logCommand("select retail_state where id=1", started, data ? 1 : 0, error);
  if (error) {
    appErrorLog(randomUUID(), error, { path: "supabase:retail_state.select" });
    throw new AppError("The store is temporarily unavailable. Please try again.", 503, "unavailable");
  }
  if (!data?.data) return null;
  return data.data as unknown;
}

/** Saves the snapshot; `sealed` is its encrypted form (T295), stored instead of the plain data. */
export async function saveSupabaseState(state: StoreData, sealed: SealedText | null = null): Promise<void> {
  const client = supabaseAdmin();
  if (!client) return;
  const started = Date.now();
  const { error } = await client.from("retail_state").upsert({
    id: 1,
    data: sealed ?? state,
    version: state.version,
    updated_at: new Date().toISOString(),
  });
  logCommand(`upsert retail_state id=1 version=${state.version} encrypted=${sealed ? "yes" : "no"}`, started, 1, error);
  if (error) {
    appErrorLog(randomUUID(), error, { path: "supabase:retail_state.upsert" });
    throw new AppError("Could not save your change. Please try again.", 503, "unavailable");
  }
  const { rows: orders, purge } = orderFeedPlan(state);
  if (purge.length) {
    // Restricted accounts: their rows leave the processor's realtime copy (T754).
    const purgeStarted = Date.now();
    const removed = await client.from("order_feed").delete().in("user_id", purge);
    logCommand(`delete order_feed where user_id in (${purge.length} restricted accounts)`, purgeStarted, purge.length, removed.error);
    if (removed.error) appErrorLog(randomUUID(), removed.error, { path: "supabase:order_feed.delete" });
  }
  if (orders.length) {
    const feedStarted = Date.now();
    const feed = await client.from("order_feed").upsert(orders);
    logCommand(`upsert order_feed ids=${orders.slice(0, 5).map((row) => row.id).join(",")}${orders.length > 5 ? ",..." : ""}`, feedStarted, orders.length, feed.error);
    // The snapshot is already saved; a failed realtime mirror is logged instead of failing the request.
    if (feed.error) appErrorLog(randomUUID(), feed.error, { path: "supabase:order_feed.upsert" });
  }
}

/** Every command this application sends to the database is logged with its table, scope, row count and duration. */
function logCommand(command: string, started: number, rows: number, error: unknown) {
  dbLog({ type: "db.query", outcome: error ? "failure" : "success", durationMs: Date.now() - started, detail: `${command} rows=${rows}` });
}

/**
 * Rows mirrored to the realtime feed: the latest orders of accounts that did not restrict live
 * order tracking, plus the accounts whose existing rows must be removed.
 */
export function orderFeedPlan(state: StoreData) {
  const purge = feedRestrictedUsers(state);
  const rows = state.orders
    .filter((order) => !purge.includes(order.userId))
    .slice(0, RESULT_CAPS.orderFeed)
    .map((order) => ({
      id: order.id,
      user_id: order.userId,
      number: order.number,
      payment_status: order.paymentStatus,
      delivery_status: order.deliveryStatus,
      updated_at: order.updatedAt,
    }));
  return { rows, purge };
}
