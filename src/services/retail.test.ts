import assert from "node:assert/strict";
import test from "node:test";
import { login } from "./auth";
import { resetStore } from "../lib/db/store";
import * as retail from "./retail";
import { decidePrivacy } from "./privacy";
import { PRIVACY_NOTICE_VERSION } from "../lib/privacy";
import { testPassword } from "../test/support";

process.env.ACME_DATA_PATH = "memory";
// The seed password is generated per test run; no password is hard-coded.
const SEED_PASSWORD = testPassword();
process.env.ACME_SEED_PASSWORD = SEED_PASSWORD;

async function customer() {
  await resetStore();
  const result = await login("customer@acme-retail.test", SEED_PASSWORD);
  // Checkout collects a shipping address, which needs the accepted privacy notice.
  await decidePrivacy(result.user.id, { decision: "accept", noticeVersion: PRIVACY_NOTICE_VERSION, language: "en", consents: {} }, { sessionRef: "test", ip: "127.0.0.1", userAgent: "test" });
  return result;
}

test("seed has forty products and sixty orders", async () => {
  await resetStore();
  const catalog = await retail.listCatalog({});
  const actor = (await login("admin@acme-retail.test", SEED_PASSWORD)).user;
  const orders = await retail.listOrders(actor);
  assert.equal(catalog.products.length, 40);
  assert.equal(catalog.total, 40);
  assert.equal(orders.total, 60);
  assert.equal(orders.items.length, 20, "lists are paginated on the server");
});

test("checkout reserves stock and saves the purchase price", async () => {
  const actor = (await customer()).user;
  const catalog = await retail.listCatalog({ inStock: true });
  const variant = catalog.products[0].variants[0];
  const before = variant.stock;
  await retail.mutateCart("cart-test", actor.id, variant.id, 1);
  const started = await retail.startCheckout({
    userId: actor.id,
    cartId: "cart-test",
    shippingMethod: "standard",
    couponCode: "WELCOME10",
    address: { fullName: "Avery Chen", line1: "18 Market Street", city: "San Francisco", region: "CA", postalCode: "94105", country: "US" },
    scenario: "approved",
  });
  assert.ok(started.checkout.discountCents > 0);
  const order = await retail.payCheckout(actor.id, started.checkout.id);
  assert.equal(order.paymentStatus, "approved");
  assert.equal(order.deliveryStatus, "processing");
  assert.equal(order.items[0].unitPriceCents, variant.priceCents);
  const after = (await retail.listInventory()).items;
  const updated = after.find((item) => item.id === variant.id);
  assert.equal(updated?.stock, before - 1);
});

test("declined payment releases the reservation and does not capture stock", async () => {
  const actor = (await customer()).user;
  const catalog = await retail.listCatalog({});
  const variant = catalog.products[3].variants[0];
  const before = variant.stock;
  await retail.mutateCart("cart-decline", actor.id, variant.id, 1);
  const started = await retail.startCheckout({
    userId: actor.id,
    cartId: "cart-decline",
    shippingMethod: "express",
    address: { fullName: "Avery Chen", line1: "18 Market Street", city: "San Francisco", region: "CA", postalCode: "94105", country: "US" },
    scenario: "declined",
  });
  const order = await retail.payCheckout(actor.id, started.checkout.id);
  assert.equal(order.paymentStatus, "declined");
  assert.equal(order.deliveryStatus, "pending");
  const after = (await retail.listInventory()).items;
  assert.equal(after.find((item) => item.id === variant.id)?.stock, before);
  assert.equal(after.find((item) => item.id === variant.id)?.reserved, 0);
});

test("partial refund keeps delivery status", async () => {
  const actor = (await customer()).user;
  const finance = await login("finance@acme-retail.test", SEED_PASSWORD);
  const catalog = await retail.listCatalog({});
  const variant = catalog.products[5].variants[0];
  await retail.mutateCart("cart-refund", actor.id, variant.id, 2);
  const started = await retail.startCheckout({
    userId: actor.id,
    cartId: "cart-refund",
    shippingMethod: "standard",
    address: { fullName: "Avery Chen", line1: "18 Market Street", city: "San Francisco", region: "CA", postalCode: "94105", country: "US" },
    scenario: "approved",
  });
  const order = await retail.payCheckout(actor.id, started.checkout.id);
  const refunded = await retail.refundOrder(finance.user, { orderId: order.id, amountCents: 100, reason: "Goodwill" });
  assert.equal(refunded.paymentStatus, "partially_refunded");
  assert.equal(refunded.deliveryStatus, "processing");
  await assert.rejects(() => retail.refundOrder(actor, { orderId: order.id, amountCents: 100, reason: "No" }));
});
