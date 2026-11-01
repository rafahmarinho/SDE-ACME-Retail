import assert from "node:assert/strict";
import test from "node:test";
import { readStore, resetStore, updateStore, assertSnapshotSize } from "./db/store";
import { MAX_SNAPSHOT_BYTES, PAGE_LIMITS, paginate, RESULT_CAPS, withinCap } from "./query-limits";
import { AppError } from "./errors";
import { advanceSimulation, mutateCart, toggleWishlist } from "../services/retail";
import { captureLogs, testPassword } from "../test/support";
import type { PublicUser } from "./types";

process.env.ACME_DATA_PATH = "memory";
process.env.ACME_SEED_PASSWORD = testPassword();
const logs = captureLogs();

const administrator: PublicUser = { id: "usr_05", email: "admin@acme-retail.test", fullName: "Jordan Hale", role: "administrator", phone: "", mustChangePassword: false, mfaEnabled: true };

function tooLarge(error: unknown) {
  return error instanceof AppError && error.status === 422 && error.code === "result_too_large";
}

test("pages never exceed the maximum size, even when a caller asks for more", () => {
  const rows = Array.from({ length: 500 }, (_, index) => index);
  const page = paginate(rows, { limit: 10_000, offset: 0 }, "orders");
  assert.equal(page.items.length, PAGE_LIMITS.orders.max);
  assert.equal(page.nextCursor, String(PAGE_LIMITS.orders.max));
  assert.equal(page.total, 500);
  assert.deepEqual(paginate(rows, { limit: 20, offset: 490 }, "orders"), { items: rows.slice(490), nextCursor: null, total: 500 });
});

test("a query over its hard cap fails with an error instead of a silent truncation", () => {
  assert.deepEqual(withinCap([1, 2, 3], 3, "test.ok"), [1, 2, 3]);
  assert.throws(() => withinCap([1, 2, 3, 4], 3, "test.over"), tooLarge);
  assert.ok(logs.some((entry) => entry.type === "query.result_too_large" && entry.detail?.includes("test.over")));
});

test("exceeding a cap inside a transaction rolls the transaction back", async () => {
  await resetStore();
  const before = await readStore((data) => data.orderSeq);
  await assert.rejects(
    updateStore((data) => {
      data.orderSeq += 1;
      withinCap(data.orders, 10, "test.rollback");
    }),
    tooLarge,
  );
  assert.equal(await readStore((data) => data.orderSeq), before, "nothing from the failed transaction was saved");
});

test("a cart holds at most the capped number of distinct items; the extra add is rolled back", async () => {
  await resetStore();
  const variants = await readStore((data) => data.variants.filter((variant) => variant.stock > 0).map((variant) => variant.id));
  assert.ok(variants.length > RESULT_CAPS.cartItems);
  for (const id of variants.slice(0, RESULT_CAPS.cartItems)) await mutateCart("cart-cap", null, id, 1);
  await assert.rejects(mutateCart("cart-cap", null, variants[RESULT_CAPS.cartItems], 1), tooLarge);
  const items = await readStore((data) => data.carts.find((cart) => cart.id === "cart-cap")!.items.length);
  assert.equal(items, RESULT_CAPS.cartItems);
  await mutateCart("cart-cap", null, variants[0], 2);
  await mutateCart("cart-cap", null, variants[1], 0);
  assert.equal(await readStore((data) => data.carts.find((cart) => cart.id === "cart-cap")!.items.length), RESULT_CAPS.cartItems - 1, "existing items can still change or be removed");
});

test("a wishlist holds at most the capped number of variants", async () => {
  await resetStore();
  await updateStore((data) => {
    const template = data.variants[0];
    for (let i = 0; i < RESULT_CAPS.wishlistItems + 5; i += 1) data.variants.push({ ...template, id: `cap_variant_${i}`, sku: `CAP-${i}` });
    data.wishlists.push({ userId: "usr_01", variantIds: Array.from({ length: RESULT_CAPS.wishlistItems }, (_, i) => `cap_variant_${i}`) });
  });
  await assert.rejects(toggleWishlist("usr_01", `cap_variant_${RESULT_CAPS.wishlistItems}`), tooLarge);
  assert.equal(await readStore((data) => data.wishlists.find((list) => list.userId === "usr_01")!.variantIds.length), RESULT_CAPS.wishlistItems);
  assert.equal((await toggleWishlist("usr_01", "cap_variant_0")).length, RESULT_CAPS.wishlistItems - 1, "removing still works");
});

test("a simulation step that would change more orders than allowed changes none", async () => {
  await resetStore();
  await updateStore((data) => {
    const template = data.orders.find((order) => order.paymentStatus === "approved" && order.deliveryStatus === "processing")!;
    for (let i = 0; i < RESULT_CAPS.simulationBatch + 1; i += 1) data.orders.push({ ...template, id: `ord_cap_${i}`, number: `AR-9${i}` });
  });
  const before = await readStore((data) => data.orders.filter((order) => order.deliveryStatus === "processing").length);
  await assert.rejects(advanceSimulation(administrator), tooLarge);
  assert.equal(await readStore((data) => data.orders.filter((order) => order.deliveryStatus === "processing").length), before);
});

test("the store refuses to load or save a snapshot above its size limit", async () => {
  await resetStore();
  assert.doesNotThrow(() => assertSnapshotSize("{}", "load"));
  assert.throws(() => assertSnapshotSize("x".repeat(MAX_SNAPSHOT_BYTES + 1), "load"), (error: unknown) => error instanceof AppError && error.status === 507);
  const before = await readStore((data) => data.events.length);
  await assert.rejects(
    updateStore((data) => {
      data.events.unshift({ id: "big", at: new Date().toISOString(), type: "test", message: "x".repeat(MAX_SNAPSHOT_BYTES), orderId: null, actorId: null });
    }),
    (error: unknown) => error instanceof AppError && error.code === "store_too_large",
  );
  assert.equal(await readStore((data) => data.events.length), before, "the oversized change was not saved");
});
