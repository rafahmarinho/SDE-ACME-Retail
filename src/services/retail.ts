import { randomUUID } from "node:crypto";
import { AppError } from "../lib/errors";
import { updateStore } from "../lib/db/store";
import { sanitizeText } from "../lib/security";
import { securityConfig } from "../lib/config";
import { DELIVERY_TRANSITIONS } from "../lib/delivery";
import { firstPage, paginate, RESULT_CAPS, withinCap, type PageRequest } from "../lib/query-limits";
import { securityLog } from "../lib/security-log";
import { marketingAudience, processingAllowed, requirePrivacyAcceptance } from "../lib/privacy-rules";
import { sendMail } from "../lib/mailer";
import { appendEvent, verifyAuditChain } from "../lib/audit";
import {
  can,
  canCancelOrder,
  canRefundOrder,
  canRequestReturn,
  canViewOrder,
  canViewReturn,
  orderFieldsFor,
} from "../lib/policy";
import type {
  AppEvent,
  CheckoutDraft,
  Coupon,
  DeliveryStatus,
  Order,
  OrderItem,
  PaymentScenario,
  PaymentStatus,
  Product,
  PublicUser,
  ShippingMethod,
  StoreData,
  Variant,
} from "../lib/types";
import { toPublicUser } from "../lib/types";

const PAID: PaymentStatus[] = ["approved", "partially_refunded"];

/** Server-side filters for order lists (the client never filters a full result). */
export interface OrderFilters {
  payment?: PaymentStatus[];
  delivery?: DeliveryStatus[];
  /** Part of an order number, e.g. "AR-1001". */
  q?: string;
}

function matchesOrder(order: Order, filters: OrderFilters) {
  if (filters.payment?.length && !filters.payment.includes(order.paymentStatus)) return false;
  if (filters.delivery?.length && !filters.delivery.includes(order.deliveryStatus)) return false;
  if (filters.q && !order.number.includes(filters.q.toUpperCase())) return false;
  return true;
}

/** Back-office list entry: only what the order screens need (no address or customer data). */
export function orderSummary(order: Order) {
  return {
    id: order.id,
    number: order.number,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    paymentStatus: order.paymentStatus,
    deliveryStatus: order.deliveryStatus,
    totalCents: order.totalCents,
    itemCount: order.items.reduce((sum, item) => sum + item.qty, 0),
    carrier: order.carrier,
    trackingNumber: order.trackingNumber,
  };
}

/** Simulation tools exist only for demos; in a release they stay off unless ACME_DEMO_MODE=enabled. */
function assertDemoMode() {
  if (!securityConfig().demoMode) {
    throw new AppError("Simulation tools are disabled in this environment.", 403, "demo_disabled");
  }
}

function nowIso() {
  return new Date().toISOString();
}

function addEvent(data: StoreData, type: string, message: string, orderId: string | null, actorId: string | null): AppEvent {
  return appendEvent(data, { type, message, orderId, actorId });
}

function releaseExpired(data: StoreData) {
  const now = Date.now();
  const expired = data.reservations.filter((item) => Date.parse(item.expiresAt) <= now);
  for (const reservation of expired) {
    const variant = data.variants.find((item) => item.id === reservation.variantId);
    if (variant) variant.reserved = Math.max(0, variant.reserved - reservation.qty);
  }
  if (expired.length) {
    data.reservations = data.reservations.filter((item) => Date.parse(item.expiresAt) > now);
    data.checkouts = data.checkouts.filter((item) => Date.parse(item.expiresAt) > now);
    addEvent(data, "reservation.expired", `Released ${expired.length} expired stock reservation(s).`, null, null);
  }
}

export function available(variant: Variant) {
  return Math.max(0, variant.stock - variant.reserved);
}

function requireUser(data: StoreData, userId: string) {
  const user = data.users.find((item) => item.id === userId);
  if (!user) throw new AppError("Account not found.", 401, "unauthorized");
  return user;
}

function findVariant(data: StoreData, variantId: string) {
  const variant = data.variants.find((item) => item.id === variantId);
  if (!variant) throw new AppError("That option is no longer available.");
  return variant;
}

function productOf(data: StoreData, productId: string) {
  const product = data.products.find((item) => item.id === productId);
  if (!product || !product.active) throw new AppError("Product not found.", 404, "not_found");
  return product;
}

export function quote(input: {
  items: OrderItem[];
  coupon: Coupon | null;
  shippingMethod: ShippingMethod;
  taxRateBps: number;
}) {
  const subtotal = input.items.reduce((sum, item) => sum + item.unitPriceCents * item.qty, 0);
  if (input.coupon && subtotal < input.coupon.minSubtotalCents) {
    throw new AppError("This coupon does not meet the minimum subtotal.");
  }
  const discountCents = !input.coupon
    ? 0
    : input.coupon.type === "percent"
      ? Math.round(subtotal * (input.coupon.value / 100))
      : input.coupon.type === "amount"
        ? Math.min(subtotal, input.coupon.value)
        : 0;
  const afterDiscount = subtotal - discountCents;
  let shippingCents = input.shippingMethod === "express" ? 1495 : 595;
  if (input.shippingMethod === "standard" && (afterDiscount >= 7500 || input.coupon?.type === "shipping")) {
    shippingCents = 0;
  }
  const taxCents = Math.round(afterDiscount * (input.taxRateBps / 10000));
  return {
    subtotalCents: subtotal,
    discountCents,
    shippingCents,
    taxCents,
    totalCents: afterDiscount + shippingCents + taxCents,
  };
}

function toOrderItem(data: StoreData, variantId: string, qty: number): OrderItem {
  const variant = findVariant(data, variantId);
  const product = productOf(data, variant.productId);
  if (qty < 1 || qty > 10) throw new AppError("Quantity must be between 1 and 10.");
  return {
    variantId,
    sku: variant.sku,
    productName: product.name,
    label: variant.label,
    qty,
    unitPriceCents: variant.priceCents,
  };
}

export async function listCatalog(filters: {
  q?: string;
  category?: string;
  min?: number;
  max?: number;
  inStock?: boolean;
  sort?: string;
}, page: PageRequest = firstPage("catalog")) {
  const { readStore } = await import("../lib/db/store");
  return readStore((data) => {
    releaseExpired(data);
    const q = (filters.q ?? "").toLowerCase();
    let products = data.products.filter((product) => product.active);
    if (q) {
      products = products.filter((product) =>
        `${product.name} ${product.description} ${product.category}`.toLowerCase().includes(q),
      );
    }
    if (filters.category) products = products.filter((product) => product.category === filters.category);
    const withPrice = products.map((product) => {
      const variants = data.variants.filter((variant) => variant.productId === product.id);
      const minPrice = Math.min(...variants.map((variant) => variant.priceCents));
      const stock = variants.reduce((sum, variant) => sum + available(variant), 0);
      return { product, variants, minPrice, stock };
    });
    let rows = withPrice;
    if (filters.min) rows = rows.filter((row) => row.minPrice >= filters.min!);
    if (filters.max) rows = rows.filter((row) => row.minPrice <= filters.max!);
    if (filters.inStock) rows = rows.filter((row) => row.stock > 0);
    if (filters.sort === "price_asc") rows.sort((a, b) => a.minPrice - b.minPrice);
    else if (filters.sort === "price_desc") rows.sort((a, b) => b.minPrice - a.minPrice);
    else if (filters.sort === "name") rows.sort((a, b) => a.product.name.localeCompare(b.product.name));
    else rows.sort((a, b) => Number(b.product.featured) - Number(a.product.featured));
    const result = paginate(rows, page, "catalog");
    return {
      categories: [...new Set(data.products.map((product) => product.category))].sort(),
      products: result.items,
      nextCursor: result.nextCursor,
      total: result.total,
    };
  });
}

export async function getProduct(slug: string) {
  const { readStore } = await import("../lib/db/store");
  return readStore((data) => {
    const product = data.products.find((item) => item.slug === slug && item.active);
    if (!product) return null;
    const variants = data.variants
      .filter((variant) => variant.productId === product.id)
      .map((variant) => ({ ...variant, available: available(variant) }));
    return { product, variants };
  });
}

export async function getCartView(cartId: string) {
  const { readStore } = await import("../lib/db/store");
  return readStore((data) => cartView(data, cartId));
}

function cartView(data: StoreData, cartId: string) {
  const cart = data.carts.find((item) => item.id === cartId) ?? {
    id: cartId,
    userId: null,
    items: [],
    updatedAt: nowIso(),
  };
  const items = cart.items.slice(0, RESULT_CAPS.cartItems).flatMap((item) => {
    const variant = data.variants.find((row) => row.id === item.variantId);
    const product = variant && data.products.find((row) => row.id === variant.productId);
    if (!variant || !product) return [];
    return [{ ...item, variant, product, lineCents: variant.priceCents * item.qty, available: available(variant) }];
  });
  return {
    id: cart.id,
    items,
    subtotalCents: items.reduce((sum, item) => sum + item.lineCents, 0),
  };
}

export async function mutateCart(cartId: string, userId: string | null, variantId: string, qty: number) {
  return updateStore((data) => {
    let cart = data.carts.find((item) => item.id === cartId);
    if (!cart) {
      cart = { id: cartId, userId, items: [], updatedAt: nowIso() };
      data.carts.push(cart);
    }
    if (userId) cart.userId = userId;
    const existing = cart.items.find((item) => item.variantId === variantId);
    if (qty <= 0) cart.items = cart.items.filter((item) => item.variantId !== variantId);
    else {
      const variant = findVariant(data, variantId);
      productOf(data, variant.productId);
      const nextQty = Math.min(10, qty);
      if (nextQty > available(variant)) throw new AppError("Not enough stock for that quantity.");
      if (existing) existing.qty = nextQty;
      else {
        cart.items.push({ variantId, qty: nextQty });
        withinCap(cart.items, RESULT_CAPS.cartItems, "cart.items");
      }
    }
    cart.updatedAt = nowIso();
    return cartView(data, cartId);
  });
}

export async function mergeCart(guestCartId: string, userId: string) {
  return updateStore((data) => {
    const userCart = data.carts.find((item) => item.userId === userId);
    const guest = data.carts.find((item) => item.id === guestCartId);
    if (!guest) return userCart?.id ?? guestCartId;
    if (!userCart || userCart.id === guest.id) {
      guest.userId = userId;
      return guest.id;
    }
    const distinct = new Set([...userCart.items, ...guest.items].map((item) => item.variantId));
    if (distinct.size > RESULT_CAPS.cartItems) {
      // The merge would exceed the cart cap: it is not applied and both carts stay as they were.
      securityLog({ type: "query.result_too_large", outcome: "blocked", actorId: userId, detail: `cart merge: ${distinct.size} items exceed the cap of ${RESULT_CAPS.cartItems}` });
      return userCart.id;
    }
    for (const item of guest.items) {
      const existing = userCart.items.find((row) => row.variantId === item.variantId);
      if (existing) existing.qty = Math.min(10, existing.qty + item.qty);
      else userCart.items.push(item);
    }
    data.carts = data.carts.filter((item) => item.id !== guest.id);
    return userCart.id;
  });
}

export async function toggleWishlist(userId: string, variantId: string) {
  return updateStore((data) => {
    requireUser(data, userId);
    findVariant(data, variantId);
    let list = data.wishlists.find((item) => item.userId === userId);
    if (!list) {
      list = { userId, variantIds: [] };
      data.wishlists.push(list);
    }
    if (list.variantIds.includes(variantId)) list.variantIds = list.variantIds.filter((id) => id !== variantId);
    else {
      list.variantIds.push(variantId);
      withinCap(list.variantIds, RESULT_CAPS.wishlistItems, "wishlist.items");
    }
    return list.variantIds;
  });
}

export async function getWishlist(userId: string) {
  const { readStore } = await import("../lib/db/store");
  return readStore((data) => {
    const ids = (data.wishlists.find((item) => item.userId === userId)?.variantIds ?? []).slice(0, RESULT_CAPS.wishlistItems);
    return ids.flatMap((id) => {
      const variant = data.variants.find((item) => item.id === id);
      const product = variant && data.products.find((item) => item.id === variant.productId);
      return variant && product ? [{ variant, product }] : [];
    });
  });
}

export async function startCheckout(input: {
  userId: string;
  cartId: string;
  couponCode?: string;
  shippingMethod: ShippingMethod;
  address: CheckoutDraft["address"];
  scenario?: PaymentScenario;
}) {
  return updateStore((data) => {
    releaseExpired(data);
    const user = requireUser(data, input.userId);
    if (!can(user.role, "orders.purchase")) {
      throw new AppError("Only customer accounts can place orders.", 403, "forbidden");
    }
    // The shipping address is personal data: it is accepted only after the privacy notice (T178).
    requirePrivacyAcceptance(data, user.id);
    const address = {
      fullName: sanitizeText(input.address.fullName, 80),
      line1: sanitizeText(input.address.line1, 120),
      city: sanitizeText(input.address.city, 80),
      region: sanitizeText(input.address.region, 40),
      postalCode: sanitizeText(input.address.postalCode, 16),
      country: sanitizeText(input.address.country, 2).toUpperCase() || "US",
    };
    if (!address.line1 || !address.city || !address.postalCode) {
      throw new AppError("A complete shipping address is required.");
    }
    const cart = data.carts.find((item) => item.id === input.cartId && item.userId === input.userId);
    if (!cart || cart.items.length === 0) throw new AppError("Your cart is empty.");
    const items = cart.items.map((item) => toOrderItem(data, item.variantId, item.qty));
    for (const item of items) {
      const variant = findVariant(data, item.variantId);
      if (item.qty > available(variant)) throw new AppError(`${item.productName} does not have enough stock.`);
    }
    const coupon = input.couponCode
      ? data.coupons.find((item) => item.code === input.couponCode!.toUpperCase() && item.active) ?? null
      : null;
    if (input.couponCode && !coupon) throw new AppError("Coupon not found or inactive.");
    const priced = quote({
      items,
      coupon,
      shippingMethod: input.shippingMethod,
      taxRateBps: data.settings.taxRateBps,
    });
    const checkoutId = randomUUID();
    const expiresAt = new Date(Date.now() + data.settings.reservationMinutes * 60_000).toISOString();
    for (const item of items) {
      const variant = findVariant(data, item.variantId);
      variant.reserved += item.qty;
      data.reservations.push({
        id: randomUUID(),
        checkoutId,
        userId: input.userId,
        variantId: item.variantId,
        qty: item.qty,
        unitPriceCents: item.unitPriceCents,
        expiresAt,
      });
    }
    const draft: CheckoutDraft = {
      id: checkoutId,
      userId: input.userId,
      cartId: cart.id,
      items,
      couponCode: coupon?.code ?? null,
      discountCents: priced.discountCents,
      shippingMethod: input.shippingMethod,
      shippingCents: priced.shippingCents,
      taxCents: priced.taxCents,
      totalCents: priced.totalCents,
      address,
      // Customers may pick the simulated outcome only when the demo feature is enabled.
      scenario: (securityConfig().demoMode ? input.scenario : undefined) ?? data.settings.paymentScenario,
      expiresAt,
      createdAt: nowIso(),
    };
    data.checkouts.push(draft);
    addEvent(data, "checkout.reserved", `Reserved stock for checkout ${checkoutId.slice(0, 8)}.`, null, input.userId);
    return { checkout: draft, priced };
  });
}

function releaseCheckout(data: StoreData, checkoutId: string) {
  const rows = data.reservations.filter((item) => item.checkoutId === checkoutId);
  for (const row of rows) {
    const variant = data.variants.find((item) => item.id === row.variantId);
    if (variant) variant.reserved = Math.max(0, variant.reserved - row.qty);
  }
  data.reservations = data.reservations.filter((item) => item.checkoutId !== checkoutId);
}

function commitStock(data: StoreData, checkoutId: string) {
  const rows = data.reservations.filter((item) => item.checkoutId === checkoutId);
  for (const row of rows) {
    const variant = data.variants.find((item) => item.id === row.variantId);
    if (!variant || variant.reserved < row.qty || variant.stock < row.qty) {
      throw new AppError("Stock reservation could not be completed.");
    }
    variant.reserved -= row.qty;
    variant.stock -= row.qty;
  }
  data.reservations = data.reservations.filter((item) => item.checkoutId !== checkoutId);
}

function createOrder(data: StoreData, draft: CheckoutDraft, paymentStatus: PaymentStatus, deliveryStatus: DeliveryStatus): Order {
  data.orderSeq += 1;
  const order: Order = {
    id: randomUUID(),
    number: `AR-${data.orderSeq}`,
    userId: draft.userId,
    items: draft.items,
    couponCode: draft.couponCode,
    discountCents: draft.discountCents,
    shippingMethod: draft.shippingMethod,
    shippingCents: draft.shippingCents,
    taxCents: draft.taxCents,
    totalCents: draft.totalCents,
    paymentStatus,
    deliveryStatus,
    paymentScenario: draft.scenario,
    address: draft.address,
    carrier: null,
    trackingNumber: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  data.orders.unshift(order);
  const cart = data.carts.find((item) => item.id === draft.cartId);
  if (cart) cart.items = [];
  data.checkouts = data.checkouts.filter((item) => item.id !== draft.id);
  return order;
}

export async function completeStripeCheckout(checkoutId: string) {
  return updateStore((data) => {
    const draft = data.checkouts.find((item) => item.id === checkoutId);
    if (!draft) return null;
    commitStock(data, draft.id);
    const order = createOrder(data, draft, "approved", "processing");
    addEvent(data, "payment.approved", `Stripe test-mode checkout completed for ${order.number}.`, order.id, draft.userId);
    return order;
  });
}

export async function payCheckout(userId: string, checkoutId: string) {
  return updateStore((data) => {
    releaseExpired(data);
    const draft = data.checkouts.find((item) => item.id === checkoutId && item.userId === userId);
    if (!draft) throw new AppError("Checkout expired or was not found.", 404, "not_found");
    const scenario = draft.scenario;
    if (scenario === "approved") {
      commitStock(data, draft.id);
      const order = createOrder(data, draft, "approved", "processing");
      addEvent(data, "payment.approved", `Simulated payment approved for ${order.number}.`, order.id, userId);
      return order;
    }
    if (scenario === "authentication_required") {
      const order = createOrder(data, draft, "authentication_required", "pending");
      data.reservations.forEach((item) => {
        if (item.checkoutId === checkoutId) item.checkoutId = order.id;
      });
      addEvent(data, "payment.authentication_required", `Authentication required for ${order.number}.`, order.id, userId);
      return order;
    }
    releaseCheckout(data, draft.id);
    const status: PaymentStatus = scenario === "declined" ? "declined" : "timeout";
    const order = createOrder(data, draft, status, "pending");
    addEvent(data, `payment.${status}`, `Simulated payment ${status} for ${order.number}. No charge was made.`, order.id, userId);
    return order;
  });
}

export async function completeAuthentication(userId: string, orderId: string) {
  return updateStore((data) => {
    const order = data.orders.find((item) => item.id === orderId && item.userId === userId);
    if (!order || order.paymentStatus !== "authentication_required") {
      throw new AppError("This order is not waiting for authentication.", 404, "not_found");
    }
    if (data.settings.authChallengeResult === "declined") {
      releaseCheckout(data, order.id);
      order.paymentStatus = "declined";
      order.updatedAt = nowIso();
      addEvent(data, "payment.declined", `Authentication failed for ${order.number}.`, order.id, userId);
      return order;
    }
    const rows = data.reservations.filter((item) => item.checkoutId === order.id);
    for (const row of rows) {
      const variant = findVariant(data, row.variantId);
      if (variant.reserved < row.qty) throw new AppError("Reservation expired. Place the order again.");
      variant.reserved -= row.qty;
      variant.stock -= row.qty;
    }
    data.reservations = data.reservations.filter((item) => item.checkoutId !== order.id);
    order.paymentStatus = "approved";
    order.deliveryStatus = "processing";
    order.updatedAt = nowIso();
    addEvent(data, "payment.approved", `Authentication completed for ${order.number}.`, order.id, userId);
    return order;
  });
}

/**
 * Orders visible to the actor, one page at a time: staff with orders.view get summaries of every
 * order, everyone else only their own orders.
 */
export async function listOrders(actor: PublicUser, page: PageRequest = firstPage("orders"), filters: OrderFilters = {}) {
  const { readStore } = await import("../lib/db/store");
  return readStore((data) => {
    if (can(actor.role, "orders.view")) {
      return paginate(data.orders.filter((order) => matchesOrder(order, filters)).map(orderSummary), page, "orders");
    }
    return paginate(data.orders.filter((order) => order.userId === actor.id && matchesOrder(order, filters)), page, "orders");
  });
}

export async function getOrder(actor: PublicUser, orderId: string) {
  const { readStore } = await import("../lib/db/store");
  return readStore((data) => orderView(data, actor, findVisibleOrder(data, actor, orderId)));
}

/** Object-level check: the order must belong to the actor or the actor must hold orders.view. */
function findVisibleOrder(data: StoreData, actor: PublicUser, orderId: string) {
  const order = data.orders.find((item) => item.id === orderId || item.number === orderId);
  if (!order || !canViewOrder(actor, order)) throw new AppError("Order not found.", 404, "not_found");
  return order;
}

function orderView(data: StoreData, actor: PublicUser, order: Order) {
  const fields = orderFieldsFor(actor, order);
  const { address, ...withoutAddress } = order;
  const phone = data.users.find((user) => user.id === order.userId)?.phone ?? "";
  // Shared with fulfilment only while the customer allows delivery contact by phone (T604, T754).
  const contactPhone = fields.contactPhone && phone && processingAllowed(data, order.userId, "delivery_phone") ? phone : null;
  return {
    order: fields.address ? { ...withoutAddress, address, ...(contactPhone ? { contactPhone } : {}) } : withoutAddress,
    // Latest events only (newest first); refunds and returns per order are bounded by business rules and capped.
    events: fields.events ? data.events.filter((event) => event.orderId === order.id).slice(0, RESULT_CAPS.orderEvents) : [],
    refunds: fields.refunds ? withinCap(data.refunds.filter((refund) => refund.orderId === order.id), RESULT_CAPS.orderRefunds, "order.refunds") : [],
    returns: fields.returns ? withinCap(data.returns.filter((item) => item.orderId === order.id), RESULT_CAPS.orderReturns, "order.returns") : [],
  };
}

function refundedSoFar(data: StoreData, orderId: string) {
  return data.refunds.filter((item) => item.orderId === orderId).reduce((sum, item) => sum + item.amountCents, 0);
}

export async function cancelOrder(actor: PublicUser, orderId: string) {
  return updateStore((data) => {
    const order = findVisibleOrder(data, actor, orderId);
    if (!canCancelOrder(actor, order)) {
      throw new AppError("Only the customer or the finance team can cancel this order.", 403, "forbidden");
    }
    if (["shipped", "out_for_delivery", "delivered", "returned", "return_requested"].includes(order.deliveryStatus)) {
      throw new AppError("Shipped orders must be returned instead of cancelled.");
    }
    if (order.deliveryStatus === "cancelled" || order.paymentStatus === "cancelled") {
      throw new AppError("Order is already cancelled.");
    }
    if (PAID.includes(order.paymentStatus) || order.paymentStatus === "refunded") {
      restock(data, order);
      const remaining = order.totalCents - refundedSoFar(data, order.id);
      if (remaining > 0) {
        data.refunds.push({
          id: randomUUID(),
          orderId: order.id,
          amountCents: remaining,
          reason: "Cancellation before shipment",
          partial: remaining < order.totalCents,
          status: "completed",
          actorId: actor.id,
          createdAt: nowIso(),
        });
      }
      order.paymentStatus = "refunded";
    } else {
      releaseCheckout(data, order.id);
      order.paymentStatus = "cancelled";
    }
    order.deliveryStatus = "cancelled";
    order.updatedAt = nowIso();
    addEvent(data, "order.cancelled", `${order.number} cancelled. Payment and delivery statuses were updated separately.`, order.id, actor.id);
    return order;
  });
}

function restock(data: StoreData, order: Order) {
  for (const item of order.items) {
    const variant = data.variants.find((row) => row.id === item.variantId);
    if (variant) variant.stock += item.qty;
  }
}

export async function createReturn(actor: PublicUser, input: { orderId: string; items: { variantId: string; qty: number; reason: string }[]; note: string; photoId: string | null }) {
  return updateStore((data) => {
    const order = findVisibleOrder(data, actor, input.orderId);
    if (!canRequestReturn(actor, order)) {
      throw new AppError("Only the customer who placed the order can request a return.", 403, "forbidden");
    }
    if (!["delivered", "shipped", "out_for_delivery"].includes(order.deliveryStatus)) {
      throw new AppError("Returns are available after the order has shipped.");
    }
    if (input.items.length === 0) throw new AppError("Select at least one item to return.");
    const totals = new Map<string, number>();
    for (const item of input.items) totals.set(item.variantId, (totals.get(item.variantId) ?? 0) + item.qty);
    for (const [variantId, qty] of totals) {
      const bought = order.items.find((row) => row.variantId === variantId);
      if (!bought || qty < 1 || qty > bought.qty) throw new AppError("Return quantity exceeds what was purchased.");
    }
    const id = randomUUID();
    let photoId: string | null = null;
    if (input.photoId) {
      // Indirect reference: the id maps to a stored object only if this customer uploaded it.
      const upload = data.uploads.find((item) => item.id === input.photoId && item.userId === actor.id && !item.returnId);
      if (!upload) throw new AppError("Photo not found.", 404, "not_found");
      upload.returnId = id;
      photoId = upload.id;
    }
    const request = {
      id,
      orderId: order.id,
      userId: order.userId,
      items: input.items.map((item) => ({ ...item, reason: sanitizeText(item.reason, 160) })),
      status: "requested" as const,
      note: sanitizeText(input.note, 400),
      photoId,
      createdAt: nowIso(),
    };
    data.returns.unshift(request);
    order.deliveryStatus = "return_requested";
    order.updatedAt = nowIso();
    addEvent(data, "return.requested", `Return requested for ${order.number}.`, order.id, actor.id);
    return request;
  });
}

export async function refundOrder(actor: PublicUser, input: { orderId: string; amountCents: number; reason: string }) {
  return updateStore((data) => {
    if (!can(actor.role, "refunds.issue")) throw new AppError("You cannot issue refunds.", 403, "forbidden");
    const order = data.orders.find((item) => item.id === input.orderId);
    if (!order) throw new AppError("Order not found.", 404, "not_found");
    if (!canRefundOrder(actor, order)) throw new AppError("You cannot refund an order you placed.", 403, "forbidden");
    const reason = sanitizeText(input.reason, 200);
    if (reason.length < 3) throw new AppError("Give a reason for the refund.");
    if (!["approved", "partially_refunded"].includes(order.paymentStatus)) {
      throw new AppError("Only captured payments can be refunded.");
    }
    const already = data.refunds.filter((item) => item.orderId === order.id).reduce((sum, item) => sum + item.amountCents, 0);
    const remaining = order.totalCents - already;
    if (input.amountCents < 1 || input.amountCents > remaining) {
      throw new AppError(`Refund must be between $0.01 and the remaining ${(remaining / 100).toFixed(2)}.`);
    }
    const partial = input.amountCents < remaining;
    data.refunds.push({
      id: randomUUID(),
      orderId: order.id,
      amountCents: input.amountCents,
      reason,
      partial,
      status: "completed",
      actorId: actor.id,
      createdAt: nowIso(),
    });
    order.paymentStatus = partial ? "partially_refunded" : "refunded";
    order.updatedAt = nowIso();
    addEvent(data, "refund.completed", `${partial ? "Partial" : "Full"} simulated refund on ${order.number}. Delivery status was not changed.`, order.id, actor.id);
    return order;
  });
}

export async function updateDelivery(actor: PublicUser, orderId: string, status: DeliveryStatus, trackingNumber?: string) {
  return updateStore((data) => {
    if (!can(actor.role, "orders.fulfil")) {
      throw new AppError("You cannot update delivery.", 403, "forbidden");
    }
    const order = data.orders.find((item) => item.id === orderId);
    if (!order) throw new AppError("Order not found.", 404, "not_found");
    if (!DELIVERY_TRANSITIONS[order.deliveryStatus]?.includes(status)) {
      throw new AppError(`Delivery cannot move from ${order.deliveryStatus} to ${status}.`, 409, "invalid_transition");
    }
    if (["shipped", "out_for_delivery", "delivered"].includes(status) && !PAID.includes(order.paymentStatus)) {
      throw new AppError("Only paid orders can be shipped.", 409, "invalid_transition");
    }
    order.deliveryStatus = status;
    if (trackingNumber) {
      order.trackingNumber = sanitizeText(trackingNumber, 40);
      order.carrier = "ACME Parcel";
    }
    if (status === "returned") {
      restock(data, order);
      for (const item of data.returns) {
        if (item.orderId === order.id && item.status === "requested") item.status = "received";
      }
    }
    order.updatedAt = nowIso();
    addEvent(data, "delivery.updated", `${order.number} delivery is now ${status}.`, order.id, actor.id);
    return order;
  });
}

export async function saveProduct(actor: PublicUser, input: { id?: string; name: string; description: string; category: string; priceCents: number; active: boolean }) {
  return updateStore((data) => {
    if (!can(actor.role, "catalog.manage")) throw new AppError("You cannot edit the catalog.", 403, "forbidden");
    const name = sanitizeText(input.name, 80);
    const description = sanitizeText(input.description, 400);
    const category = sanitizeText(input.category, 40);
    if (!name || !description || !category || input.priceCents < 50) throw new AppError("Product details are incomplete.");
    let product = input.id ? data.products.find((item) => item.id === input.id) : undefined;
    if (!product) {
      product = {
        id: randomUUID(),
        slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${data.products.length + 1}`,
        name,
        description,
        category,
        imageHue: data.products.length * 17,
        active: input.active,
        featured: false,
        rating: 0,
      };
      data.products.push(product);
      data.variants.push({
        id: randomUUID(),
        productId: product.id,
        sku: `AC-NEW-${data.variants.length + 1}`,
        label: "Standard",
        options: { Option: "Standard" },
        priceCents: input.priceCents,
        stock: 0,
        reserved: 0,
      });
    } else {
      product.name = name;
      product.description = description;
      product.category = category;
      product.active = input.active;
      const variant = data.variants.find((item) => item.productId === product!.id);
      if (variant) variant.priceCents = input.priceCents;
    }
    addEvent(data, "catalog.updated", `Catalog updated: ${product.name}.`, null, actor.id);
    return product;
  });
}

export async function adjustStock(actor: PublicUser, variantId: string, delta: number) {
  return updateStore((data) => {
    if (!can(actor.role, "inventory.adjust")) throw new AppError("You cannot adjust inventory.", 403, "forbidden");
    const variant = findVariant(data, variantId);
    const next = variant.stock + delta;
    if (next < variant.reserved || next > 100000) throw new AppError("Stock adjustment is outside the allowed range.");
    variant.stock = next;
    addEvent(data, "inventory.adjusted", `${variant.sku} stock changed by ${delta}.`, null, actor.id);
    return variant;
  });
}

export async function updateSettings(actor: PublicUser, patch: Partial<StoreData["settings"]>) {
  return updateStore((data) => {
    if (!can(actor.role, "scenarios.manage")) throw new AppError("Only administrators can change scenarios.", 403, "forbidden");
    assertDemoMode();
    const before = { ...data.settings };
    if (patch.paymentScenario) data.settings.paymentScenario = patch.paymentScenario;
    if (patch.authChallengeResult) data.settings.authChallengeResult = patch.authChallengeResult;
    const changed = (["paymentScenario", "authChallengeResult"] as const).filter((key) => before[key] !== data.settings[key]);
    if (changed.length) {
      securityLog({ type: "config.changed", outcome: "success", actorId: actor.id, detail: changed.map((key) => `${key}: ${before[key]}->${data.settings[key]}`).join(", ") });
    }
    addEvent(data, "scenario.updated", `Payment scenario set to ${data.settings.paymentScenario}.`, null, actor.id);
    return data.settings;
  });
}

export async function advanceSimulation(actor: PublicUser) {
  return updateStore((data) => {
    if (!can(actor.role, "scenarios.manage")) throw new AppError("Only administrators can advance the simulation.", 403, "forbidden");
    assertDemoMode();
    const flow: DeliveryStatus[] = ["processing", "shipped", "out_for_delivery", "delivered"];
    const movable = data.orders.filter((order) => {
      const index = flow.indexOf(order.deliveryStatus);
      return PAID.includes(order.paymentStatus) && index !== -1 && index < flow.length - 1;
    });
    // One step may change at most RESULT_CAPS.simulationBatch orders; more rolls the whole step back.
    withinCap(movable, RESULT_CAPS.simulationBatch, "advanceSimulation");
    let moved = 0;
    for (const order of movable) {
      const index = flow.indexOf(order.deliveryStatus);
      order.deliveryStatus = flow[index + 1];
      if (order.deliveryStatus === "shipped") {
        order.carrier = "ACME Parcel";
        order.trackingNumber = order.trackingNumber ?? `1ZACME${order.number.replace(/\D/g, "")}`;
      }
      order.updatedAt = nowIso();
      addEvent(data, "delivery.updated", `${order.number} advanced to ${order.deliveryStatus}.`, order.id, actor.id);
      moved += 1;
    }
    return { moved };
  });
}

export async function resetDemo(actor: PublicUser) {
  if (!can(actor.role, "scenarios.manage")) throw new AppError("Only administrators can reset demo data.", 403, "forbidden");
  assertDemoMode();
  const { resetStore } = await import("../lib/db/store");
  await resetStore();
  return updateStore((data) => {
    addEvent(data, "demo.reset", "Demo data was reset to the seed catalog and orders.", null, actor.id);
    return { ok: true, products: data.products.length, orders: data.orders.length };
  });
}

export async function listEvents(page: PageRequest = firstPage("events")) {
  const { readStore } = await import("../lib/db/store");
  return readStore((data) => paginate(data.events, page, "events"));
}

/**
 * Read-only audit trail for oversight (T349): one page of events plus the verification of the
 * hash chain over every retained event. A broken chain is logged as a security event.
 */
export async function auditTrail(page: PageRequest = firstPage("events")) {
  const { readStore } = await import("../lib/db/store");
  const result = await readStore((data) => ({ integrity: verifyAuditChain(data.events), page: paginate(data.events, page, "events") }));
  if (!result.integrity.ok) {
    securityLog({ type: "audit.integrity_failed", outcome: "failure", detail: `audit chain broken at event ${result.integrity.brokenAt}` });
  }
  return result;
}

export async function getSettings() {
  const { readStore } = await import("../lib/db/store");
  return readStore((data) => data.settings);
}

export async function listInventory(page: PageRequest = firstPage("inventory"), q = "") {
  const { readStore } = await import("../lib/db/store");
  const needle = q.toLowerCase();
  return readStore((data) => {
    const rows = data.variants.map((variant) => ({
      ...variant,
      available: available(variant),
      productName: data.products.find((product) => product.id === variant.productId)?.name ?? "Unknown",
    }));
    return paginate(needle ? rows.filter((row) => `${row.sku} ${row.productName}`.toLowerCase().includes(needle)) : rows, page, "inventory");
  });
}

export async function listReturns(actor: PublicUser, page: PageRequest = firstPage("returns")) {
  const { readStore } = await import("../lib/db/store");
  return readStore((data) => paginate(data.returns.filter((item) => canViewReturn(actor, item)), page, "returns"));
}

export async function listRefunds(page: PageRequest = firstPage("refunds")) {
  const { readStore } = await import("../lib/db/store");
  return readStore((data) => paginate([...data.refunds].reverse(), page, "refunds"));
}

export async function officeOrders(page: PageRequest = firstPage("officeOrders"), filters: OrderFilters = {}) {
  const { readStore } = await import("../lib/db/store");
  return readStore((data) => paginate(data.orders.filter((order) => matchesOrder(order, filters)).map(orderSummary), page, "officeOrders"));
}

/**
 * Profile details. Personal data is accepted only after the privacy notice; a new phone number
 * only while delivery contact by phone is allowed (consent given and not restricted). Consent
 * itself is managed on the privacy endpoints, never through the profile.
 */
export async function saveProfile(userId: string, patch: { fullName: string; phone: string; address?: CheckoutDraft["address"] }) {
  return updateStore((data) => {
    const user = requireUser(data, userId);
    requirePrivacyAcceptance(data, userId);
    const phone = sanitizeText(patch.phone, 30);
    if (phone && phone !== user.phone && !processingAllowed(data, userId, "delivery_phone")) {
      throw new AppError("Allow delivery contact by phone on the Privacy page before adding a phone number.", 409, "consent_required");
    }
    user.fullName = sanitizeText(patch.fullName, 80);
    user.phone = phone;
    if (!user.fullName) throw new AppError("Name is required.");
    if (patch.address) {
      const existing = data.addresses.find((item) => item.userId === userId && item.isDefault);
      const next = {
        id: existing?.id ?? randomUUID(),
        userId,
        fullName: user.fullName,
        line1: sanitizeText(patch.address.line1, 120),
        city: sanitizeText(patch.address.city, 80),
        region: sanitizeText(patch.address.region, 40),
        postalCode: sanitizeText(patch.address.postalCode, 16),
        country: "US",
        isDefault: true,
      };
      if (existing) Object.assign(existing, next);
      else data.addresses.push(next);
    }
    addEvent(data, "profile.updated", "Profile details updated.", null, userId);
    return toPublicUser(user);
  });
}

/**
 * Product update e-mail (consent-based processing, T604/T754): sent one by one, only to customers
 * whose marketing consent is current and not restricted at the moment of sending. Each message
 * says how to withdraw the consent.
 */
export async function announceProduct(actor: PublicUser, productId: string) {
  if (!can(actor.role, "catalog.manage")) throw new AppError("You cannot announce products.", 403, "forbidden");
  const plan = await updateStore((data) => {
    const product = data.products.find((item) => item.id === productId && item.active);
    if (!product) throw new AppError("Product not found.", 404, "not_found");
    const audience = withinCap(marketingAudience(data), RESULT_CAPS.marketingBatch, "marketing.audience");
    addEvent(data, "marketing.announced", `Product update for ${product.name} sent to ${audience.length} customer(s) who opted in.`, null, actor.id);
    return { name: product.name, slug: product.slug, audience: [...audience] };
  });
  const config = securityConfig();
  const origin = config.appOrigin ?? (config.production ? "" : "http://localhost:3000");
  for (const recipient of plan.audience) {
    await sendMail({
      to: recipient.email,
      subject: `New at ACME Retail: ${plan.name}`,
      text:
        `Hello ${recipient.fullName},\n\n${plan.name} is now in our catalog: ${origin}/product/${plan.slug}\n\n` +
        `You receive this e-mail because you opted in to product updates. To stop them, withdraw this consent at ${origin}/account/privacy.`,
      category: "marketing",
      unsubscribeUrl: `${origin}/account/privacy`,
    });
  }
  return { sent: plan.audience.length };
}

export function previewQuote(items: OrderItem[], couponCode: string | null, shippingMethod: ShippingMethod, coupons: Coupon[], taxRateBps: number) {
  const coupon = couponCode ? coupons.find((item) => item.code === couponCode && item.active) ?? null : null;
  return quote({ items, coupon, shippingMethod, taxRateBps });
}

export type { Product };

/** Records an uploaded return photo and returns the opaque id the client uses to reference it. */
export async function recordUpload(userId: string, input: { objectName: string; contentType: string; size: number }) {
  return updateStore((data) => {
    requireUser(data, userId);
    const upload = {
      id: randomUUID(),
      userId,
      objectName: input.objectName,
      contentType: input.contentType,
      size: input.size,
      returnId: null,
      createdAt: nowIso(),
    };
    data.uploads.push(upload);
    addEvent(data, "upload.stored", `Return photo uploaded (${input.contentType}, ${input.size} bytes).`, null, userId);
    return { id: upload.id };
  });
}
