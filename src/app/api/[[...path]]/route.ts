import { NextResponse } from "next/server";
import { z } from "zod";
import {
  applyCsrfCookie,
  assertSafeUrl,
  authorizeRoute,
  cartId,
  clearClientState,
  clearSessionCookie,
  ensureCartCookie,
  guardMutation,
  jsonError,
  LIMITS,
  prepareCsrf,
  readBodyText,
  readCookie,
  readForm,
  readJson,
  requestIp,
  requireActor,
  SESSION_COOKIE,
  setSessionCookie,
  sharedThrottle,
  throttle,
  trustedOrigin,
} from "@/lib/http";
import { AppError } from "@/lib/errors";
import { detectImageType, IMAGE_CONTENT_TYPES, isAllowedImage, randomToken, sanitizeText, sha256, verifyStripeSignature } from "@/lib/security";
import { beginMfaSetup, changePassword, consumeChallenge, disableMfa, enableMfa, issueChallenge, login, logout, requestReset, resetPassword, stepUp } from "@/services/auth";
import { decidePrivacy, getPrivacy, updateConsents, updateRestrictions, type ConsentEvidence } from "@/services/privacy";
import { CONSENT_ITEMS, RESTRICTABLE_ACTIVITIES, type ConsentItemId, type RestrictableId } from "@/lib/privacy";
import {
  adjustStock,
  advanceSimulation,
  announceProduct,
  auditTrail,
  cancelOrder,
  completeAuthentication,
  completeStripeCheckout,
  createReturn,
  getCartView,
  getOrder,
  getProduct,
  getSettings,
  getWishlist,
  listCatalog,
  listEvents,
  listInventory,
  listOrders,
  listRefunds,
  listReturns,
  mergeCart,
  mutateCart,
  officeOrders,
  orderSummary,
  payCheckout,
  recordUpload,
  refundOrder,
  resetDemo,
  saveProduct,
  saveProfile,
  startCheckout,
  toggleWishlist,
  updateDelivery,
  updateSettings,
} from "@/services/retail";
import { createStripeCheckout, stripeTestConfigured } from "@/services/stripe";
import { saveLocalUpload, sealUpload } from "@/lib/db/store";
import { DELIVERY_STATUSES, PAYMENT_SCENARIOS, PAYMENT_STATUSES, type Order, type PublicUser } from "@/lib/types";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { matchApiRoute, orderFieldsFor, permissionsOf, type ApiRoute } from "@/lib/policy";
import {
  adjustedVariantDto,
  adminEventDto,
  cartDto,
  catalogDto,
  enforceResponseContract,
  inventoryRowDto,
  officeRefundDto,
  orderDetailDto,
  orderDto,
  pageDto,
  productDetailDto,
  returnDto,
  savedProductDto,
  wishlistDto,
} from "@/lib/api-contract";
import { securityLog } from "@/lib/security-log";
import { serverTooBusy } from "@/lib/load";
import { parsePage } from "@/lib/query-limits";

const idSchema = z.string().min(3).max(80).regex(/^[A-Za-z0-9_-]+$/);

const addressSchema = z.object({
  fullName: z.string().min(2).max(80),
  line1: z.string().min(3).max(120),
  city: z.string().min(2).max(80),
  region: z.string().min(2).max(40),
  postalCode: z.string().min(3).max(16),
  country: z.string().length(2).default("US"),
});

const catalogQuery = z.object({
  q: z.string().max(100).optional(),
  category: z.string().max(40).optional(),
  min: z.coerce.number().int().min(0).max(10_000_000).optional(),
  max: z.coerce.number().int().min(0).max(10_000_000).optional(),
  inStock: z.enum(["0", "1"]).optional(),
  sort: z.enum(["featured", "price_asc", "price_desc", "name"]).optional(),
});

/** Server-side order filters: comma-separated status lists and part of an order number. */
const orderListQuery = z.object({
  payment: z.string().max(200).optional(),
  delivery: z.string().max(200).optional(),
  q: z.string().max(20).regex(/^[A-Za-z0-9-]*$/).optional(),
});

function orderFilters(params: URLSearchParams) {
  const query = orderListQuery.parse({ payment: params.get("payment") ?? undefined, delivery: params.get("delivery") ?? undefined, q: params.get("q") ?? undefined });
  return {
    payment: query.payment ? z.array(z.enum(PAYMENT_STATUSES)).max(PAYMENT_STATUSES.length).parse(query.payment.split(",")) : undefined,
    delivery: query.delivery ? z.array(z.enum(DELIVERY_STATUSES)).max(DELIVERY_STATUSES.length).parse(query.delivery.split(",")) : undefined,
    q: query.q || undefined,
  };
}

const inventoryQuery = z.string().max(60).optional();

/** Consent items and restrictable activities come from the privacy register (src/lib/privacy.ts). */
const consentShape = Object.fromEntries(CONSENT_ITEMS.map((id) => [id, z.boolean().optional()]));
const restrictionShape = Object.fromEntries(RESTRICTABLE_ACTIVITIES.map((id) => [id, z.boolean().optional()]));
const hasChange = (value: Record<string, unknown>) => Object.values(value).some((item) => item !== undefined);

const privacyDecisionSchema = z.object({
  decision: z.enum(["accept", "decline"]),
  noticeVersion: z.string().min(1).max(20),
  language: z.string().max(35).regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8}){0,3}$/),
  consents: z.strictObject(consentShape).default({}),
});
const consentChangesSchema = z.strictObject(consentShape).refine(hasChange);
const restrictionChangesSchema = z.strictObject(restrictionShape).refine(hasChange);

/** An order as this actor may see it: the address only for the owner and fulfilment (see orderFieldsFor). */
function orderForActor(actor: PublicUser, order: Order) {
  const { address, ...rest } = order;
  return orderDto(orderFieldsFor(actor, order).address ? { ...rest, address } : rest);
}

/** Proof attached to every privacy decision: the signed-in session (hash prefix), IP and browser. */
function consentEvidence(request: Request): ConsentEvidence {
  return {
    sessionRef: sha256(readCookie(request, SESSION_COOKIE) ?? "").slice(0, 16),
    ip: requestIp(request),
    userAgent: sanitizeText(request.headers.get("user-agent") ?? "", 160),
  };
}

/** Read endpoints share a generous per-IP budget that still stops bulk scraping. */
const READ_LIMIT = 900;

async function handle(request: Request, pathParts: string[], actor: PublicUser | null) {
  const [root, second, third] = pathParts;
  const method = request.method;
  const ip = requestIp(request);

  if (method === "GET") throttle(request, "read", READ_LIMIT);

  if (method === "GET" && root === "session") {
    // The page keeps the anti-CSRF token in memory and sends it with every state-changing call.
    const csrf = prepareCsrf(request);
    const response = NextResponse.json({ user: actor, permissions: actor ? permissionsOf(actor.role) : [], stripe: stripeTestConfigured(), csrfToken: csrf.token });
    applyCsrfCookie(response, csrf);
    return response;
  }
  if (method === "GET" && root === "catalog") {
    const params = new URL(request.url).searchParams;
    const query = catalogQuery.parse({ q: params.get("q") ?? undefined, category: params.get("category") ?? undefined, min: params.get("min") ?? undefined, max: params.get("max") ?? undefined, inStock: params.get("inStock") ?? undefined, sort: params.get("sort") ?? undefined });
    return NextResponse.json(
      catalogDto(
        await listCatalog(
          {
            q: query.q,
            category: query.category,
            min: query.min || undefined,
            max: query.max || undefined,
            inStock: query.inStock === "1",
            sort: query.sort,
          },
          parsePage("catalog", params),
        ),
      ),
    );
  }
  if (method === "GET" && root === "products" && second) {
    const product = await getProduct(second);
    if (!product) return NextResponse.json({ error: "Product not found." }, { status: 404 });
    return NextResponse.json(productDetailDto(product));
  }
  if (root === "cart" && method === "GET") {
    const id = cartId(request);
    const response = NextResponse.json(cartDto(await getCartView(id)));
    await ensureCartCookie(response, id);
    return response;
  }
  if (root === "cart" && method === "POST") {
    guardMutation(request, "cart");
    const body = z.object({ variantId: idSchema, qty: z.number().int().min(0).max(10) }).parse(await readJson(request));
    const id = cartId(request);
    const response = NextResponse.json(cartDto(await mutateCart(id, actor?.id ?? null, body.variantId, body.qty)));
    await ensureCartCookie(response, id);
    return response;
  }
  if (root === "wishlist" && method === "GET") {
    const user = requireActor(actor);
    return NextResponse.json(wishlistDto(await getWishlist(user.id)));
  }
  if (root === "wishlist" && method === "POST") {
    guardMutation(request, "wishlist");
    const user = requireActor(actor);
    const body = z.object({ variantId: idSchema }).parse(await readJson(request));
    return NextResponse.json({ variantIds: await toggleWishlist(user.id, body.variantId) });
  }
  if (root === "auth" && second === "login" && method === "POST") {
    guardMutation(request, "login", 10);
    const body = z.object({ email: z.email().max(120), password: z.string().min(1).max(128) }).parse(await readJson(request));
    await sharedThrottle(request, "login", 10, body.email);
    const result = await login(body.email, body.password, { ip });
    const nextCart = await mergeCart(cartId(request), result.user.id);
    // A new identity gets a new anti-CSRF secret: tokens issued before sign-in stop working.
    const csrf = prepareCsrf(request, true);
    const response = NextResponse.json({ user: result.user, permissions: permissionsOf(result.user.role), csrfToken: csrf.token });
    setSessionCookie(response, result.token);
    applyCsrfCookie(response, csrf);
    await ensureCartCookie(response, nextCart);
    return response;
  }
  if (root === "auth" && second === "logout" && method === "POST") {
    guardMutation(request, "logout");
    const token = readCookie(request, SESSION_COOKIE);
    if (token) await logout(token, { ip });
    const response = NextResponse.json({ ok: true });
    clearClientState(response);
    return response;
  }
  if (root === "auth" && second === "challenge" && method === "POST") {
    guardMutation(request, "challenge", 30);
    return NextResponse.json(await issueChallenge());
  }
  if (root === "auth" && second === "recover" && method === "POST") {
    guardMutation(request, "recover", 5);
    const body = z.object({ email: z.email().max(120), challengeId: z.uuid(), nonce: z.string().regex(/^\d{1,12}$/) }).parse(await readJson(request));
    throttle(request, "recover-account", 5, body.email.toLowerCase());
    await sharedThrottle(request, "recover", 5, body.email);
    // Anti-automation (T2): a solved, unused proof-of-work challenge is required.
    await consumeChallenge(body.challengeId, body.nonce, { ip });
    await requestReset(body.email, { ip });
    return NextResponse.json({
      message: "If an account exists for that email, password reset instructions have been sent to it.",
    });
  }
  if (root === "auth" && second === "reset" && method === "POST") {
    guardMutation(request, "reset", 8);
    const body = z
      .object({ token: z.string().min(20).max(200).regex(/^[a-f0-9]+$/), password: z.string().min(12).max(128) })
      .parse(await readJson(request));
    await sharedThrottle(request, "reset", 8);
    await resetPassword(body.token, body.password, { ip });
    return NextResponse.json({ ok: true });
  }
  if (root === "auth" && second === "step-up" && method === "POST") {
    const user = requireActor(actor);
    guardMutation(request, "step-up", 10, { accountKey: user.id });
    const body = z
      .strictObject({ code: z.string().min(6).max(20).optional(), password: z.string().min(1).max(128).optional() })
      .refine((value) => Boolean(value.code) !== Boolean(value.password))
      .parse(await readJson(request));
    await sharedThrottle(request, "step-up", 10, user.id);
    const result = await stepUp(user.id, readCookie(request, SESSION_COOKIE), body, { ip });
    // A new session ticket is issued at the privilege change; the old one no longer works.
    const response = NextResponse.json({ ok: true, validUntil: result.validUntil });
    setSessionCookie(response, result.token);
    return response;
  }
  if (root === "account" && second === "mfa" && third === "setup" && method === "POST") {
    const user = requireActor(actor);
    guardMutation(request, "mfa", 10, { accountKey: user.id });
    return NextResponse.json(await beginMfaSetup(user.id, { ip }));
  }
  if (root === "account" && second === "mfa" && third === "enable" && method === "POST") {
    const user = requireActor(actor);
    guardMutation(request, "mfa", 10, { accountKey: user.id });
    const body = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(await readJson(request));
    await sharedThrottle(request, "mfa-enable", 10, user.id);
    return NextResponse.json(await enableMfa(user.id, body.code, readCookie(request, SESSION_COOKIE), { ip }));
  }
  if (root === "account" && second === "mfa" && third === "disable" && method === "POST") {
    const user = requireActor(actor);
    guardMutation(request, "mfa", 10, { accountKey: user.id });
    await disableMfa(user.id, { ip });
    return NextResponse.json({ ok: true });
  }
  if (root === "account" && !second && method === "PATCH") {
    guardMutation(request, "account");
    const user = requireActor(actor);
    const body = z
      .object({
        fullName: z.string().min(2).max(80),
        phone: z.string().max(30),
        address: addressSchema.optional(),
      })
      .parse(await readJson(request));
    return NextResponse.json(await saveProfile(user.id, body));
  }
  if (root === "account" && second === "privacy" && !third && method === "GET") {
    const user = requireActor(actor);
    return NextResponse.json(await getPrivacy(user.id));
  }
  if (root === "account" && second === "privacy" && !third && method === "POST") {
    guardMutation(request, "privacy", 20);
    const user = requireActor(actor);
    const body = privacyDecisionSchema.parse(await readJson(request));
    return NextResponse.json(await decidePrivacy(user.id, { ...body, consents: body.consents as Partial<Record<ConsentItemId, boolean>> }, consentEvidence(request)));
  }
  if (root === "account" && second === "privacy" && third === "consents" && method === "PATCH") {
    guardMutation(request, "privacy", 20);
    const user = requireActor(actor);
    const body = consentChangesSchema.parse(await readJson(request)) as Partial<Record<ConsentItemId, boolean>>;
    return NextResponse.json(await updateConsents(user.id, body, consentEvidence(request)));
  }
  if (root === "account" && second === "privacy" && third === "restrictions" && method === "PATCH") {
    guardMutation(request, "privacy", 20);
    const user = requireActor(actor);
    const body = restrictionChangesSchema.parse(await readJson(request)) as Partial<Record<RestrictableId, boolean>>;
    return NextResponse.json(await updateRestrictions(user.id, body, consentEvidence(request)));
  }
  if (root === "account" && second === "password" && method === "POST") {
    guardMutation(request, "password", 8);
    const user = requireActor(actor);
    const body = z.object({ current: z.string().min(1).max(128), next: z.string().min(12).max(128) }).parse(await readJson(request));
    await changePassword(user.id, body.current, body.next, { ip });
    const response = NextResponse.json({ ok: true });
    clearSessionCookie(response);
    return response;
  }
  if (root === "checkout" && method === "POST" && !second) {
    guardMutation(request, "checkout", 12);
    const user = requireActor(actor, "orders.purchase");
    const body = z
      .object({
        couponCode: z.string().max(20).optional(),
        shippingMethod: z.enum(["standard", "express"]),
        address: addressSchema,
        scenario: z.enum(PAYMENT_SCENARIOS).optional(),
        provider: z.enum(["simulated", "stripe"]).optional(),
      })
      .parse(await readJson(request));
    const origin = body.provider === "stripe" ? trustedOrigin(request) : null;
    const started = await startCheckout({
      userId: user.id,
      cartId: cartId(request),
      couponCode: body.couponCode,
      shippingMethod: body.shippingMethod,
      address: { ...body.address, country: body.address.country ?? "US" },
      scenario: body.scenario,
    });
    if (origin) {
      // Only the redirect target is returned; the reservation details stay on the server.
      return NextResponse.json({ stripeUrl: await createStripeCheckout(started.checkout, origin) });
    }
    const order = await payCheckout(user.id, started.checkout.id);
    return NextResponse.json({ order: orderDto(order) });
  }
  if (root === "orders" && second && third === "authenticate" && method === "POST") {
    guardMutation(request, "pay", 10);
    const user = requireActor(actor);
    return NextResponse.json(orderDto(await completeAuthentication(user.id, idSchema.parse(second))));
  }
  if (root === "orders" && second && third === "cancel" && method === "POST") {
    guardMutation(request, "cancel");
    const user = requireActor(actor);
    return NextResponse.json(orderForActor(user, await cancelOrder(user, idSchema.parse(second))));
  }
  if (root === "orders" && method === "GET" && !second) {
    const user = requireActor(actor);
    const params = new URL(request.url).searchParams;
    const result = await listOrders(user, parsePage("orders", params), orderFilters(params));
    // Customers get their own orders (as DTOs); staff with orders.view get the minimal summaries.
    const items = (result.items as (Order | ReturnType<typeof orderSummary>)[]).map((order) => ("address" in order ? orderDto(order) : order));
    return NextResponse.json({ items, nextCursor: result.nextCursor, total: result.total });
  }
  if (root === "orders" && method === "GET" && second) {
    const user = requireActor(actor);
    return NextResponse.json(orderDetailDto(await getOrder(user, idSchema.parse(second))));
  }
  if (root === "returns" && method === "GET") {
    const user = requireActor(actor);
    return NextResponse.json(pageDto(await listReturns(user, parsePage("returns", new URL(request.url).searchParams)), returnDto));
  }
  if (root === "returns" && method === "POST") {
    guardMutation(request, "returns", 10);
    const user = requireActor(actor, "orders.purchase");
    const body = z
      .object({
        orderId: idSchema,
        note: z.string().max(400),
        photoId: z.uuid().nullable().optional(),
        items: z.array(z.object({ variantId: idSchema, qty: z.number().int().min(1).max(10), reason: z.string().min(3).max(160) })).min(1).max(10),
      })
      .parse(await readJson(request));
    return NextResponse.json(returnDto(await createReturn(user, { ...body, photoId: body.photoId ?? null })));
  }
  if (root === "uploads" && method === "POST") {
    guardMutation(request, "upload", 8, { upload: true });
    const user = requireActor(actor, "orders.purchase");
    const form = await readForm(request, LIMITS.upload);
    const file = form.get("file");
    if (!(file instanceof File)) throw new AppError("Choose an image to upload.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = detectImageType(bytes);
    if (!type || !isAllowedImage(bytes, file.name)) throw new AppError("Upload a PNG, JPEG, or WebP image under 2 MB.");
    // The stored name and content type come from the server, never from the client.
    const objectName = `${user.id}-${randomToken(8)}.${type}`;
    const contentType = IMAGE_CONTENT_TYPES[type];
    const admin = supabaseAdmin();
    if (admin) {
      // Sealed with the data key before it leaves the server (T295).
      const stored = sealUpload(bytes, contentType);
      const { error } = await admin.storage.from("return-photos").upload(objectName, stored.body, { contentType: stored.contentType, upsert: false });
      if (error) throw new AppError("The file could not be stored.");
    } else {
      await saveLocalUpload(objectName, bytes);
    }
    const upload = await recordUpload(user.id, { objectName, contentType, size: bytes.byteLength });
    securityLog({ type: "upload.stored", outcome: "success", actorId: user.id, ip, detail: `${contentType} ${bytes.byteLength} bytes` });
    return NextResponse.json(upload);
  }
  if (root === "office" && second === "inventory" && method === "GET") {
    requireActor(actor, "inventory.view");
    const params = new URL(request.url).searchParams;
    return NextResponse.json(pageDto(await listInventory(parsePage("inventory", params), inventoryQuery.parse(params.get("q") ?? undefined)), inventoryRowDto));
  }
  if (root === "office" && second === "inventory" && method === "POST") {
    guardMutation(request, "inventory");
    const user = requireActor(actor, "inventory.adjust");
    const body = z.object({ variantId: idSchema, delta: z.number().int().min(-1000).max(1000) }).parse(await readJson(request));
    return NextResponse.json(adjustedVariantDto(await adjustStock(user, body.variantId, body.delta)));
  }
  if (root === "office" && second === "products" && third && pathParts[3] === "announce" && method === "POST") {
    guardMutation(request, "announce", 10);
    const user = requireActor(actor, "catalog.manage");
    return NextResponse.json(await announceProduct(user, idSchema.parse(third)));
  }
  if (root === "office" && second === "products" && !third && method === "POST") {
    guardMutation(request, "products");
    const user = requireActor(actor, "catalog.manage");
    const body = z
      .object({
        id: idSchema.optional(),
        name: z.string().min(2).max(80),
        description: z.string().min(4).max(400),
        category: z.string().min(2).max(40),
        priceCents: z.number().int().min(50).max(500000),
        active: z.boolean(),
      })
      .parse(await readJson(request));
    return NextResponse.json(savedProductDto(await saveProduct(user, body)));
  }
  if (root === "office" && second === "orders" && method === "GET") {
    requireActor(actor, "orders.view");
    const params = new URL(request.url).searchParams;
    return NextResponse.json(await officeOrders(parsePage("officeOrders", params), orderFilters(params)));
  }
  if (root === "office" && second === "orders" && pathParts[3] === "delivery" && method === "POST") {
    guardMutation(request, "delivery");
    const user = requireActor(actor, "orders.fulfil");
    const body = z.object({ status: z.enum(DELIVERY_STATUSES), trackingNumber: z.string().max(40).optional() }).parse(await readJson(request));
    return NextResponse.json(orderForActor(user, await updateDelivery(user, idSchema.parse(third), body.status, body.trackingNumber)));
  }
  if (root === "office" && second === "refunds" && method === "GET") {
    requireActor(actor, "refunds.view");
    return NextResponse.json(pageDto(await listRefunds(parsePage("refunds", new URL(request.url).searchParams)), officeRefundDto));
  }
  if (root === "office" && second === "refunds" && method === "POST") {
    guardMutation(request, "refunds", 12);
    const user = requireActor(actor, "refunds.issue");
    const body = z
      .object({ orderId: idSchema, amountCents: z.number().int().min(1).max(10_000_000), reason: z.string().min(3).max(200) })
      .parse(await readJson(request));
    return NextResponse.json(orderForActor(user, await refundOrder(user, body)));
  }
  if (root === "office" && second === "audit" && method === "GET") {
    requireActor(actor, "events.view");
    const trail = await auditTrail(parsePage("events", new URL(request.url).searchParams));
    return NextResponse.json({ integrity: trail.integrity, items: trail.page.items.map(adminEventDto), nextCursor: trail.page.nextCursor, total: trail.page.total });
  }
  if (root === "scenarios" && method === "GET") {
    requireActor(actor, "scenarios.manage");
    const events = await listEvents(parsePage("events", new URL(request.url).searchParams));
    return NextResponse.json({ settings: await getSettings(), events: events.items.map(adminEventDto), nextCursor: events.nextCursor });
  }
  if (root === "scenarios" && method === "POST") {
    guardMutation(request, "scenarios", 10);
    const user = requireActor(actor, "scenarios.manage");
    const body = z
      .object({
        action: z.enum(["advance", "reset", "settings"]),
        paymentScenario: z.enum(PAYMENT_SCENARIOS).optional(),
        authChallengeResult: z.enum(["approved", "declined"]).optional(),
      })
      .parse(await readJson(request));
    securityLog({ type: "admin.action", outcome: "success", actorId: user.id, ip, detail: `scenarios:${body.action}` });
    if (body.action === "advance") return NextResponse.json(await advanceSimulation(user));
    if (body.action === "reset") return NextResponse.json(await resetDemo(user));
    return NextResponse.json(await updateSettings(user, body));
  }
  if (root === "webhooks" && second === "stripe" && method === "POST") {
    throttle(request, "webhook", 120);
    const payload = await readBodyText(request, LIMITS.webhook);
    // During a secret rotation the previous secret is accepted too (see KEY_REGISTRY in src/lib/keys.ts).
    const secrets = [process.env.STRIPE_WEBHOOK_SECRET, process.env.STRIPE_WEBHOOK_SECRET_PREVIOUS].filter((value): value is string => Boolean(value));
    if (!secrets.some((secret) => verifyStripeSignature(payload, request.headers.get("stripe-signature"), secret))) {
      securityLog({ type: "webhook.signature_invalid", outcome: "blocked", ip, detail: "stripe" });
      return NextResponse.json({ error: "Invalid Stripe signature." }, { status: 400 });
    }
    let event: { type?: string; data?: { object?: { metadata?: { checkoutId?: string } } } };
    try {
      event = JSON.parse(payload);
    } catch {
      throw new AppError("The request body is not valid JSON.", 400, "bad_request");
    }
    if (event.type === "checkout.session.completed" && event.data?.object?.metadata?.checkoutId) {
      await completeStripeCheckout(idSchema.parse(event.data.object.metadata.checkoutId));
    }
    return NextResponse.json({ received: true });
  }
  if (root === "csp-report" && method === "POST") {
    throttle(request, "csp-report", 60);
    const text = await readBodyText(request, LIMITS.cspReport);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    const legacy = (parsed as { "csp-report"?: Record<string, unknown> } | null)?.["csp-report"];
    const modern = Array.isArray(parsed) ? (parsed[0] as { body?: Record<string, unknown> } | undefined)?.body : undefined;
    const report = legacy ?? modern ?? {};
    const directive = String(report["violated-directive"] ?? report.effectiveDirective ?? "unknown");
    const blocked = String(report["blocked-uri"] ?? report.blockedURL ?? "unknown");
    const page = String(report["document-uri"] ?? report.documentURL ?? "unknown");
    securityLog({ type: "csp.violation", outcome: "blocked", ip, detail: `${directive} blocked ${blocked} on ${page}` });
    return new NextResponse(null, { status: 204 });
  }
  return NextResponse.json({ error: "Not found." }, { status: 404 });
}

function logRejected(request: Request, status: number, type: string, detail: string) {
  securityLog({ type, outcome: "blocked", ip: requestIp(request), method: request.method, path: new URL(request.url).pathname, status, detail });
}

/** Audit record for every state-changing call: who, when (UTC, ms), from where, what and the outcome. */
function auditTransaction(request: Request, route: ApiRoute | null, actor: PublicUser | null, response: Response) {
  if (request.method === "GET") return;
  securityLog({
    type: "api.transaction",
    outcome: response.status < 400 ? "success" : "failure",
    actorId: actor?.id ?? null,
    ip: requestIp(request),
    method: request.method,
    path: new URL(request.url).pathname,
    status: response.status,
    detail: route ? `${route.method} ${route.path}` : "undeclared route",
  });
}

async function dispatch(request: Request, pathParts: string[], state: { route: ApiRoute | null; actor: PublicUser | null }) {
  try {
    assertSafeUrl(request, pathParts);
    // Deny by default: only routes declared in API_ROUTES reach a handler.
    state.route = matchApiRoute(request.method, pathParts);
    if (!state.route) {
      logRejected(request, 404, "route.unknown", "No API route is declared for this method and path.");
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    state.actor = await authorizeRoute(request, state.route);
    return await handle(request, pathParts, state.actor);
  } catch (error) {
    if (error instanceof z.ZodError) {
      logRejected(request, 400, "input.invalid", error.issues.map((issue) => issue.path.join(".")).join(","));
      return NextResponse.json({ error: "Check the form and try again.", code: "invalid_input" }, { status: 400 });
    }
    if (error instanceof AppError && [400, 413, 415].includes(error.status)) {
      logRejected(request, error.status, "input.invalid", error.message);
    }
    return jsonError(error, request);
  }
}

async function entry(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  if (serverTooBusy()) {
    logRejected(request, 503, "server.busy", "Request shed while the event loop is overloaded.");
    return NextResponse.json({ error: "The service is busy. Please try again shortly.", code: "busy" }, { status: 503, headers: { "Retry-After": "5" } });
  }
  const { path: pathParts = [] } = await context.params;
  const state: { route: ApiRoute | null; actor: PublicUser | null } = { route: null, actor: null };
  const handled = await dispatch(request, pathParts, state);
  // Every body is validated against the route's declared response schema before it is sent (T2139).
  const response = await enforceResponseContract(request, state.route, handled);
  auditTransaction(request, state.route, state.actor, response);
  return response;
}

async function unsupported(request: Request) {
  logRejected(request, 405, "method.unsupported", "Unsupported HTTP method.");
  return NextResponse.json({ error: "Method not allowed." }, { status: 405, headers: { Allow: "GET, POST, PATCH" } });
}

export const GET = entry;
export const POST = entry;
export const PATCH = entry;
export const PUT = unsupported;
export const DELETE = unsupported;
