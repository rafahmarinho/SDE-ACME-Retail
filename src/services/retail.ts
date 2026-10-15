import { randomUUID } from "node:crypto";
import { AppError } from "../lib/errors";
import { updateStore } from "../lib/db/store";
import { sanitizeText } from "../lib/security";
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
  Role,
  ShippingMethod,
  StoreData,
  Variant,
} from "../lib/types";
import { toPublicUser } from "../lib/types";

const STAFF: Role[] = ["catalog", "warehouse", "finance", "administrator"];

export function can(role: Role, area: "products" | "inventory" | "orders" | "refunds" | "scenarios" | "shop"): boolean {
  if (area === "shop") return true;
  if (role === "administrator") return true;
  if (area === "products") return role === "catalog";
  if (area === "inventory") return role === "warehouse";
  if (area === "orders") return role === "warehouse" || role === "finance" || role === "catalog";
  if (area === "refunds") return role === "finance";
  return false;
}

function nowIso() {
  return new Date().toISOString();
}

function addEvent(data: StoreData, type: string, message: string, orderId: string | null, actorId: string | null) {
  const event: AppEvent = {
    id: randomUUID(),
    at: nowIso(),
    type,
    message: sanitizeText(message, 300),
    orderId,
    actorId,
  };
  data.events.unshift(event);
  data.events = data.events.slice(0, 400);
  return event;
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
}) {
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
    return {
      categories: [...new Set(data.products.map((product) => product.category))].sort(),
      products: rows,
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
  const items = cart.items.flatMap((item) => {
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
      else cart.items.push({ variantId, qty: nextQty });
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
    else list.variantIds.push(variantId);
    return list.variantIds;
  });
}

export async function getWishlist(userId: string) {
  const { readStore } = await import("../lib/db/store");
  return readStore((data) => {
    const ids = data.wishlists.find((item) => item.userId === userId)?.variantIds ?? [];
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
    if (user.role !== "customer" && user.role !== "administrator") {
      throw new AppError("Only customer accounts can place orders.", 403, "forbidden");
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
      address: {
        fullName: sanitizeText(input.address.fullName, 80),
        line1: sanitizeText(input.address.line1, 120),
        city: sanitizeText(input.address.city, 80),
        region: sanitizeText(input.address.region, 40),
        postalCode: sanitizeText(input.address.postalCode, 16),
        country: sanitizeText(input.address.country, 2).toUpperCase() || "US",
      },
      scenario: input.scenario ?? data.settings.paymentScenario,
      expiresAt,
      createdAt: nowIso(),
    };
    if (!draft.address.line1 || !draft.address.city || !draft.address.postalCode) {
      throw new AppError("A complete shipping address is required.");
    }
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

export async function listOrders(actor: PublicUser, userIdFilter?: string) {
  const { readStore } = await import("../lib/db/store");
  return readStore((data) => {
    const staff = STAFF.includes(actor.role) || actor.role === "administrator";
    return data.orders.filter((order) => (staff ? !userIdFilter || order.userId === userIdFilter : order.userId === actor.id));
  });
}

export async function getOrder(actor: PublicUser, orderId: string) {
  const { readStore } = await import("../lib/db/store");
  return readStore((data) => visibleOrder(data, actor, orderId));
}

function visibleOrder(data: StoreData, actor: PublicUser, orderId: string) {
  const order = data.orders.find((item) => item.id === orderId || item.number === orderId);
  if (!order) throw new AppError("Order not found.", 404, "not_found");
  const staff = actor.role !== "customer";
  if (!staff && order.userId !== actor.id) throw new AppError("Order not found.", 404, "not_found");
  const events = data.events.filter((event) => event.orderId === order.id);
  const refunds = data.refunds.filter((refund) => refund.orderId === order.id);
  const returns = data.returns.filter((item) => item.orderId === order.id);
  return { order, events, refunds, returns };
}

export async function cancelOrder(actor: PublicUser, orderId: string) {
  return updateStore((data) => {
    const { order } = visibleOrder(data, actor, orderId);
    if (actor.role === "customer" && order.userId !== actor.id) throw new AppError("Order not found.", 404, "not_found");
    if (["shipped", "out_for_delivery", "delivered", "returned"].includes(order.deliveryStatus)) {
      throw new AppError("Shipped orders must be returned instead of cancelled.");
    }
    if (order.deliveryStatus === "cancelled" || order.paymentStatus === "cancelled") {
      throw new AppError("Order is already cancelled.");
    }
    if (order.paymentStatus === "approved" || order.paymentStatus === "partially_refunded") {
      restock(data, order);
      if (order.paymentStatus === "approved") {
        data.refunds.push({
          id: randomUUID(),
          orderId: order.id,
          amountCents: order.totalCents,
          reason: "Cancellation before shipment",
          partial: false,
          status: "completed",
          actorId: actor.id,
          createdAt: nowIso(),
        });
        order.paymentStatus = "refunded";
      }
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

export async function createReturn(actor: PublicUser, input: { orderId: string; items: { variantId: string; qty: number; reason: string }[]; note: string; photoName: string | null }) {
  return updateStore((data) => {
    const { order } = visibleOrder(data, actor, input.orderId);
    if (order.userId !== actor.id && actor.role === "customer") throw new AppError("Order not found.", 404, "not_found");
    if (!["delivered", "shipped", "out_for_delivery"].includes(order.deliveryStatus)) {
      throw new AppError("Returns are available after the order has shipped.");
    }
    if (input.items.length === 0) throw new AppError("Select at least one item to return.");
    for (const item of input.items) {
      const bought = order.items.find((row) => row.variantId === item.variantId);
      if (!bought || item.qty < 1 || item.qty > bought.qty) throw new AppError("Return quantity exceeds what was purchased.");
    }
    const request = {
      id: randomUUID(),
      orderId: order.id,
      userId: order.userId,
      items: input.items.map((item) => ({ ...item, reason: sanitizeText(item.reason, 160) })),
      status: "requested" as const,
      note: sanitizeText(input.note, 400),
      photoName: input.photoName,
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
    if (!can(actor.role, "refunds")) throw new AppError("You cannot issue refunds.", 403, "forbidden");
    const order = data.orders.find((item) => item.id === input.orderId);
    if (!order) throw new AppError("Order not found.", 404, "not_found");
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
      reason: sanitizeText(input.reason, 200),
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
    if (actor.role !== "warehouse" && actor.role !== "administrator") {
      throw new AppError("You cannot update delivery.", 403, "forbidden");
    }
    const order = data.orders.find((item) => item.id === orderId);
    if (!order) throw new AppError("Order not found.", 404, "not_found");
    order.deliveryStatus = status;
    if (trackingNumber) {
      order.trackingNumber = sanitizeText(trackingNumber, 40);
      order.carrier = "ACME Parcel";
    }
    if (status === "returned") {
      restock(data, order);
    }
    order.updatedAt = nowIso();
    addEvent(data, "delivery.updated", `${order.number} delivery is now ${status}.`, order.id, actor.id);
    return order;
  });
}

export async function saveProduct(actor: PublicUser, input: { id?: string; name: string; description: string; category: string; priceCents: number; active: boolean }) {
  return updateStore((data) => {
    if (!can(actor.role, "products")) throw new AppError("You cannot edit the catalog.", 403, "forbidden");
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
    if (!can(actor.role, "inventory")) throw new AppError("You cannot adjust inventory.", 403, "forbidden");
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
    if (!can(actor.role, "scenarios")) throw new AppError("Only administrators can change scenarios.", 403, "forbidden");
    if (patch.paymentScenario) data.settings.paymentScenario = patch.paymentScenario;
    if (patch.authChallengeResult) data.settings.authChallengeResult = patch.authChallengeResult;
    addEvent(data, "scenario.updated", `Payment scenario set to ${data.settings.paymentScenario}.`, null, actor.id);
    return data.settings;
  });
}

export async function advanceSimulation(actor: PublicUser) {
  return updateStore((data) => {
    if (!can(actor.role, "scenarios")) throw new AppError("Only administrators can advance the simulation.", 403, "forbidden");
    const flow: DeliveryStatus[] = ["processing", "shipped", "out_for_delivery", "delivered"];
    let moved = 0;
    for (const order of data.orders) {
      if (order.paymentStatus !== "approved" && order.paymentStatus !== "partially_refunded") continue;
      const index = flow.indexOf(order.deliveryStatus);
      if (index === -1 || index === flow.length - 1) continue;
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
  if (!can(actor.role, "scenarios")) throw new AppError("Only administrators can reset demo data.", 403, "forbidden");
  const { resetStore } = await import("../lib/db/store");
  await resetStore();
  return updateStore((data) => {
    addEvent(data, "demo.reset", "Demo data was reset to the seed catalog and orders.", null, actor.id);
    return { ok: true, products: data.products.length, orders: data.orders.length };
  });
}

export async function listEvents() {
  const { readStore } = await import("../lib/db/store");
  return readStore((data) => data.events.slice(0, 80));
}

export async function getSettings() {
  const { readStore } = await import("../lib/db/store");
  return readStore((data) => data.settings);
}

export async function listInventory() {
  const { readStore } = await import("../lib/db/store");
  return readStore((data) =>
    data.variants.map((variant) => ({
      ...variant,
      available: available(variant),
      productName: data.products.find((product) => product.id === variant.productId)?.name ?? "Unknown",
    })),
  );
}

export async function listReturns(actor: PublicUser) {
  const { readStore } = await import("../lib/db/store");
  return readStore((data) =>
    data.returns.filter((item) => actor.role !== "customer" || item.userId === actor.id),
  );
}

export async function listRefunds() {
  const { readStore } = await import("../lib/db/store");
  return readStore((data) => data.refunds);
}

export async function officeOrders() {
  const { readStore } = await import("../lib/db/store");
  return readStore((data) => data.orders);
}

export async function saveProfile(userId: string, patch: { fullName: string; phone: string; marketingOptIn: boolean; address?: CheckoutDraft["address"] }) {
  return updateStore((data) => {
    const user = requireUser(data, userId);
    user.fullName = sanitizeText(patch.fullName, 80);
    user.phone = sanitizeText(patch.phone, 30);
    user.marketingOptIn = patch.marketingOptIn;
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

export function previewQuote(items: OrderItem[], couponCode: string | null, shippingMethod: ShippingMethod, coupons: Coupon[], taxRateBps: number) {
  const coupon = couponCode ? coupons.find((item) => item.code === couponCode && item.active) ?? null : null;
  return quote({ items, coupon, shippingMethod, taxRateBps });
}

export type { Product };
