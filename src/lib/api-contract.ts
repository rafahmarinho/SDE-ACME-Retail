import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { DELIVERY_STATUSES, PAYMENT_SCENARIOS, PAYMENT_STATUSES, ROLES } from "./types";
import type { AppEvent, Order, Product, Refund, ReturnRequest, Variant } from "./types";
import { API_ROUTES, PERMISSIONS, type ApiRoute } from "./policy";
import { CONSENT_ITEMS, PROCESSING_ACTIVITIES, RESTRICTABLE_ACTIVITIES } from "./privacy";
import { appErrorLog, securityLog } from "./security-log";

/**
 * API response contract (SD Elements T2139).
 *
 * Every route declared in API_ROUTES has a response schema here; errors share ErrorBody. All
 * objects are strict: a field that is not declared makes the response fail validation, and the
 * dispatcher (src/app/api/[[...path]]/route.ts) answers 500 instead of sending it. Handlers build
 * responses with the DTO mappers below, which copy only the fields an endpoint needs, so database
 * records are never returned as they are.
 */
const id = z.string().min(1).max(100);
const iso = z.string().max(40);
const cents = z.number().int();
const count = z.number().int().min(0);
const text = (max: number) => z.string().max(max);
const cursor = z.string().max(10).nullable();

export const ErrorBody = z.strictObject({ error: text(300), code: text(60).optional(), errorId: text(60).optional() });

const PublicUser = z.strictObject({ id, email: text(120), fullName: text(80), role: z.enum(ROLES), phone: text(30), mustChangePassword: z.boolean(), mfaEnabled: z.boolean() });
const Permissions = z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length);
const Ok = z.strictObject({ ok: z.literal(true) });

const PublicProduct = z.strictObject({ id, slug: text(140), name: text(80), description: text(400), category: text(40), imageHue: z.number(), featured: z.boolean(), rating: z.number() });
const PublicVariant = z.strictObject({ id, label: text(120), options: z.record(text(40), text(40)), priceCents: cents, available: count });
const CatalogRow = z.strictObject({ product: PublicProduct, variants: z.array(PublicVariant).max(50), minPrice: cents, stock: count });
const ProductRef = z.strictObject({ slug: text(140), name: text(80) });
const VariantRef = z.strictObject({ id, label: text(120), priceCents: cents });
const Cart = z.strictObject({
  items: z.array(z.strictObject({ variantId: id, qty: count, lineCents: cents, available: count, product: ProductRef, variant: VariantRef })).max(50),
  subtotalCents: cents,
});

const OrderItem = z.strictObject({ variantId: id, sku: text(40), productName: text(80), label: text(120), qty: count, unitPriceCents: cents });
const Address = z.strictObject({ fullName: text(80), line1: text(120), city: text(80), region: text(40), postalCode: text(16), country: text(2) });
/** An order as its owner or fulfilment sees it; staff without the address duty get it without address. */
const OrderDto = z.strictObject({
  id,
  number: text(20),
  items: z.array(OrderItem).max(50),
  couponCode: text(20).nullable(),
  discountCents: cents,
  shippingMethod: z.enum(["standard", "express"]),
  shippingCents: cents,
  taxCents: cents,
  totalCents: cents,
  paymentStatus: z.enum(PAYMENT_STATUSES),
  deliveryStatus: z.enum(DELIVERY_STATUSES),
  carrier: text(40).nullable(),
  trackingNumber: text(40).nullable(),
  createdAt: iso,
  updatedAt: iso,
  address: Address.optional(),
  contactPhone: text(30).optional(),
});
const OrderSummary = z.strictObject({
  id,
  number: text(20),
  createdAt: iso,
  updatedAt: iso,
  paymentStatus: z.enum(PAYMENT_STATUSES),
  deliveryStatus: z.enum(DELIVERY_STATUSES),
  totalCents: cents,
  itemCount: count,
  carrier: text(40).nullable(),
  trackingNumber: text(40).nullable(),
});
const OrderEvent = z.strictObject({ id, at: iso, type: text(60), message: text(300) });
const AdminEvent = z.strictObject({ id, at: iso, type: text(60), message: text(300), orderId: id.nullable(), actorId: id.nullable() });
const OrderRefund = z.strictObject({ id, amountCents: cents, reason: text(200), partial: z.boolean(), status: z.enum(["completed", "failed"]), createdAt: iso });
const OfficeRefund = z.strictObject({ id, orderId: id, amountCents: cents, reason: text(200), partial: z.boolean(), status: z.enum(["completed", "failed"]), actorId: id, createdAt: iso });
const ReturnDto = z.strictObject({
  id,
  orderId: id,
  items: z.array(z.strictObject({ variantId: id, qty: count, reason: text(160) })).max(10),
  status: z.enum(["requested", "approved", "rejected", "received", "refunded"]),
  note: text(400),
  photoId: id.nullable(),
  createdAt: iso,
});
const InventoryRow = z.strictObject({ id, sku: text(40), productName: text(80), label: text(120), stock: z.number().int(), reserved: count, available: count });
const Settings = z.strictObject({
  paymentScenario: z.enum(PAYMENT_SCENARIOS),
  authChallengeResult: z.enum(["approved", "declined"]),
  taxRateBps: count,
  reservationMinutes: count,
});
const activityId = z.enum(PROCESSING_ACTIVITIES.map((item) => item.id) as [string, ...string[]]);
const Privacy = z.strictObject({
  noticeVersion: text(20),
  accepted: z.boolean(),
  decision: z.enum(["accepted", "declined"]).nullable(),
  decidedAt: iso.nullable(),
  language: text(35),
  consents: z.array(z.strictObject({ id: z.enum(CONSENT_ITEMS as [string, ...string[]]), granted: z.boolean(), at: iso.nullable() })),
  restrictions: z.array(z.strictObject({ id: z.enum(RESTRICTABLE_ACTIVITIES as [string, ...string[]]), restricted: z.boolean(), at: iso.nullable() })),
  activities: z.array(z.strictObject({ id: activityId, allowed: z.boolean() })),
  history: z.array(z.strictObject({ id, at: iso, action: z.enum(["accept", "decline", "grant", "withdraw", "restrict", "lift_restriction"]), items: z.array(activityId), noticeVersion: text(20) })).max(20),
});

function page<T extends z.ZodType>(item: T, max: number) {
  return z.strictObject({ items: z.array(item).max(max), nextCursor: cursor, total: count });
}

/** Response schema of every declared route ("METHOD path"); null means the route answers 204 without a body. */
export const RESPONSE_SCHEMAS: Record<string, z.ZodType | null> = {
  "GET session": z.strictObject({ user: PublicUser.nullable(), permissions: Permissions, stripe: z.boolean(), csrfToken: text(100) }),
  "GET catalog": z.strictObject({ categories: z.array(text(40)), products: z.array(CatalogRow).max(96), nextCursor: cursor, total: count }),
  "GET products/:slug": z.strictObject({ product: PublicProduct, variants: z.array(PublicVariant).max(50) }),
  "GET cart": Cart,
  "POST cart": Cart,
  "POST auth/login": z.strictObject({ user: PublicUser, permissions: Permissions, csrfToken: text(100) }),
  "POST auth/logout": Ok,
  "POST auth/challenge": z.strictObject({ id: z.uuid(), salt: z.string().regex(/^[a-f0-9]{32}$/), difficulty: count, expiresAt: iso }),
  "POST auth/recover": z.strictObject({ message: text(200) }),
  "POST auth/reset": Ok,
  "POST auth/step-up": z.strictObject({ ok: z.literal(true), validUntil: iso }),
  "POST account/mfa/setup": z.strictObject({ secret: z.string().regex(/^[A-Z2-7]{32}$/), otpauthUri: z.string().startsWith("otpauth://totp/").max(300) }),
  "POST account/mfa/enable": z.strictObject({ recoveryCodes: z.array(z.string().regex(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/)).length(8) }),
  "POST account/mfa/disable": Ok,
  "POST webhooks/stripe": z.strictObject({ received: z.literal(true) }),
  "POST csp-report": null,
  "GET wishlist": z.array(z.strictObject({ product: ProductRef, variant: VariantRef })).max(100),
  "POST wishlist": z.strictObject({ variantIds: z.array(id).max(100) }),
  "PATCH account": PublicUser,
  "POST account/password": Ok,
  "GET account/privacy": Privacy,
  "POST account/privacy": Privacy,
  "PATCH account/privacy/consents": Privacy,
  "PATCH account/privacy/restrictions": Privacy,
  "POST checkout": z.union([z.strictObject({ order: OrderDto }), z.strictObject({ stripeUrl: z.url().max(2000) })]),
  "POST orders/:id/authenticate": OrderDto,
  "POST orders/:id/cancel": OrderDto,
  "GET orders": page(z.union([OrderDto, OrderSummary]), 50),
  "GET orders/:id": z.strictObject({ order: OrderDto, events: z.array(OrderEvent).max(50), refunds: z.array(OrderRefund).max(50), returns: z.array(ReturnDto).max(50) }),
  "GET returns": page(ReturnDto, 50),
  "POST returns": ReturnDto,
  "POST uploads": z.strictObject({ id: z.uuid() }),
  "GET office/inventory": page(InventoryRow, 200),
  "POST office/inventory": z.strictObject({ id, sku: text(40), stock: z.number().int(), reserved: count, available: count }),
  "POST office/products": z.strictObject({ id, slug: text(140), name: text(80), description: text(400), category: text(40), active: z.boolean() }),
  "POST office/products/:id/announce": z.strictObject({ sent: count }),
  "GET office/orders": page(OrderSummary, 100),
  "POST office/orders/:id/delivery": OrderDto,
  "GET office/refunds": page(OfficeRefund, 100),
  "POST office/refunds": OrderDto,
  "GET scenarios": z.strictObject({ settings: Settings, events: z.array(AdminEvent).max(100), nextCursor: cursor }),
  "GET office/audit": z.strictObject({ integrity: z.strictObject({ ok: z.boolean(), checked: count, brokenAt: id.nullable() }), items: z.array(AdminEvent).max(100), nextCursor: cursor, total: count }),
  "POST scenarios": z.union([z.strictObject({ moved: count }), z.strictObject({ ok: z.literal(true), products: count, orders: count }), Settings]),
};

export function routeKey(route: Pick<ApiRoute, "method" | "path">) {
  return `${route.method} ${route.path}`;
}

/** Routes in API_ROUTES without a declared response schema (must be empty; see the tests). */
export function undeclaredResponses(): string[] {
  return API_ROUTES.map(routeKey).filter((key) => !(key in RESPONSE_SCHEMAS));
}

export type ContractVerdict = { ok: true } | { ok: false; issues: string };

/** Validates a response body against the route's schema (ErrorBody for 4xx/5xx and undeclared routes). */
export function checkResponse(route: ApiRoute | null, status: number, body: unknown): ContractVerdict {
  const schema = status >= 400 || !route ? ErrorBody : RESPONSE_SCHEMAS[routeKey(route)];
  if (schema === undefined) return { ok: false, issues: "no response schema declared" };
  if (schema === null) return body === null ? { ok: true } : { ok: false, issues: "a body was sent where none is declared" };
  const result = schema.safeParse(body);
  if (result.success) return { ok: true };
  return { ok: false, issues: result.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "(root)"}:${issue.code}`).join(",") };
}

/**
 * Schema-based response validation, run on every API response before it leaves the server. A body
 * that does not match the declared schema is never sent: the violation is logged and the client
 * gets a generic 500 with an error id.
 */
export async function enforceResponseContract(request: Request, route: ApiRoute | null, response: Response): Promise<Response> {
  const raw = response.status === 204 ? "" : await response.clone().text();
  let body: unknown = null;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = undefined;
    }
  }
  const verdict = checkResponse(route, response.status, body);
  if (verdict.ok) return response;
  const errorId = randomUUID();
  const path = new URL(request.url).pathname;
  securityLog({ type: "response.schema_violation", outcome: "blocked", method: request.method, path, status: response.status, detail: `${route ? routeKey(route) : "undeclared route"}: ${verdict.issues}` });
  appErrorLog(errorId, new Error(`Response contract violation: ${verdict.issues}`), { method: request.method, path });
  return NextResponse.json({ error: "Something went wrong. Please try again.", errorId }, { status: 500 });
}

// ---------------------------------------------------------------- DTO mappers (copy only declared fields)

export function publicProduct(product: Product) {
  return { id: product.id, slug: product.slug, name: product.name, description: product.description, category: product.category, imageHue: product.imageHue, featured: product.featured, rating: product.rating };
}

export function publicVariant(variant: Variant) {
  return { id: variant.id, label: variant.label, options: { ...variant.options }, priceCents: variant.priceCents, available: Math.max(0, variant.stock - variant.reserved) };
}

export function catalogDto(result: { categories: string[]; products: { product: Product; variants: Variant[]; minPrice: number; stock: number }[]; nextCursor: string | null; total: number }) {
  return {
    categories: result.categories,
    products: result.products.map((row) => ({ product: publicProduct(row.product), variants: row.variants.map(publicVariant), minPrice: row.minPrice, stock: row.stock })),
    nextCursor: result.nextCursor,
    total: result.total,
  };
}

export function productDetailDto(result: { product: Product; variants: Variant[] }) {
  return { product: publicProduct(result.product), variants: result.variants.map(publicVariant) };
}

export function cartDto(view: { items: { variantId: string; qty: number; lineCents: number; available: number; product: Product; variant: Variant }[]; subtotalCents: number }) {
  return {
    items: view.items.map((item) => ({
      variantId: item.variantId,
      qty: item.qty,
      lineCents: item.lineCents,
      available: item.available,
      product: { slug: item.product.slug, name: item.product.name },
      variant: { id: item.variant.id, label: item.variant.label, priceCents: item.variant.priceCents },
    })),
    subtotalCents: view.subtotalCents,
  };
}

export function wishlistDto(rows: { product: Product; variant: Variant }[]) {
  return rows.map((row) => ({ product: { slug: row.product.slug, name: row.product.name }, variant: { id: row.variant.id, label: row.variant.label, priceCents: row.variant.priceCents } }));
}

type OrderLike = Omit<Order, "address" | "userId" | "paymentScenario"> & { address?: Order["address"]; contactPhone?: string; userId?: string; paymentScenario?: string };

/** Order fields for API responses: internal fields (owner id, simulated scenario) are never sent. */
export function orderDto(order: OrderLike) {
  return {
    id: order.id,
    number: order.number,
    items: order.items.map((item) => ({ variantId: item.variantId, sku: item.sku, productName: item.productName, label: item.label, qty: item.qty, unitPriceCents: item.unitPriceCents })),
    couponCode: order.couponCode,
    discountCents: order.discountCents,
    shippingMethod: order.shippingMethod,
    shippingCents: order.shippingCents,
    taxCents: order.taxCents,
    totalCents: order.totalCents,
    paymentStatus: order.paymentStatus,
    deliveryStatus: order.deliveryStatus,
    carrier: order.carrier,
    trackingNumber: order.trackingNumber,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    ...(order.address ? { address: { ...order.address } } : {}),
    ...(order.contactPhone ? { contactPhone: order.contactPhone } : {}),
  };
}

export function returnDto(item: ReturnRequest) {
  return { id: item.id, orderId: item.orderId, items: item.items.map((row) => ({ variantId: row.variantId, qty: row.qty, reason: row.reason })), status: item.status, note: item.note, photoId: item.photoId, createdAt: item.createdAt };
}

export function orderDetailDto(view: { order: OrderLike; events: readonly AppEvent[]; refunds: readonly Refund[]; returns: readonly ReturnRequest[] }) {
  return {
    order: orderDto(view.order),
    events: view.events.map((event) => ({ id: event.id, at: event.at, type: event.type, message: event.message })),
    refunds: view.refunds.map((refund) => ({ id: refund.id, amountCents: refund.amountCents, reason: refund.reason, partial: refund.partial, status: refund.status, createdAt: refund.createdAt })),
    returns: view.returns.map(returnDto),
  };
}

export function officeRefundDto(refund: Refund) {
  return { id: refund.id, orderId: refund.orderId, amountCents: refund.amountCents, reason: refund.reason, partial: refund.partial, status: refund.status, actorId: refund.actorId, createdAt: refund.createdAt };
}

export function inventoryRowDto(row: Variant & { productName: string; available: number }) {
  return { id: row.id, sku: row.sku, productName: row.productName, label: row.label, stock: row.stock, reserved: row.reserved, available: row.available };
}

export function adjustedVariantDto(variant: Variant) {
  return { id: variant.id, sku: variant.sku, stock: variant.stock, reserved: variant.reserved, available: Math.max(0, variant.stock - variant.reserved) };
}

export function savedProductDto(product: Product) {
  return { id: product.id, slug: product.slug, name: product.name, description: product.description, category: product.category, active: product.active };
}

export function adminEventDto(event: AppEvent) {
  return { id: event.id, at: event.at, type: event.type, message: event.message, orderId: event.orderId, actorId: event.actorId };
}

export function pageDto<T, U>(result: { items: T[]; nextCursor: string | null; total: number }, map: (item: T) => U) {
  return { items: result.items.map(map), nextCursor: result.nextCursor, total: result.total };
}
