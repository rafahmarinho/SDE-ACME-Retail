import { NextResponse } from "next/server";
import { z } from "zod";
import {
  cartId,
  clearSessionCookie,
  ensureCartCookie,
  guardMutation,
  jsonError,
  mailKey,
  MAIL_COOKIE,
  requireArea,
  requireUser,
  setSessionCookie,
} from "@/lib/http";
import { AppError } from "@/lib/errors";
import { isAllowedImage, randomToken, verifyStripeSignature } from "@/lib/security";
import { changePassword, demoMail, login, logout, requestReset, resetPassword } from "@/services/auth";
import { readSession } from "@/lib/http";
import {
  adjustStock,
  advanceSimulation,
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
  payCheckout,
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
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DELIVERY_STATUSES, PAYMENT_SCENARIOS } from "@/lib/types";
import { supabaseAdmin } from "@/lib/supabase/admin";

const addressSchema = z.object({
  fullName: z.string().min(2).max(80),
  line1: z.string().min(3).max(120),
  city: z.string().min(2).max(80),
  region: z.string().min(2).max(40),
  postalCode: z.string().min(3).max(16),
  country: z.string().length(2).default("US"),
});

async function handle(request: Request, pathParts: string[]) {
  const [root, second, third, fourth] = pathParts;
  const method = request.method;

  if (method === "GET" && root === "session") {
    return NextResponse.json({ user: await readSession(), stripe: stripeTestConfigured() });
  }
  if (method === "GET" && root === "catalog") {
    const url = new URL(request.url);
    const min = Number(url.searchParams.get("min") || 0);
    const max = Number(url.searchParams.get("max") || 0);
    return NextResponse.json(
      await listCatalog({
        q: url.searchParams.get("q") ?? undefined,
        category: url.searchParams.get("category") ?? undefined,
        min: min || undefined,
        max: max || undefined,
        inStock: url.searchParams.get("inStock") === "1",
        sort: url.searchParams.get("sort") ?? undefined,
      }),
    );
  }
  if (method === "GET" && root === "products" && second) {
    const product = await getProduct(second);
    if (!product) return NextResponse.json({ error: "Product not found." }, { status: 404 });
    return NextResponse.json(product);
  }
  if (root === "cart" && method === "GET") {
    const id = await cartId();
    const response = NextResponse.json(await getCartView(id));
    await ensureCartCookie(response, id);
    return response;
  }
  if (root === "cart" && method === "POST") {
    guardMutation(request, "cart");
    const body = z.object({ variantId: z.string().min(3).max(80), qty: z.number().int().min(0).max(10) }).parse(await request.json());
    const user = await readSession();
    const id = await cartId();
    const response = NextResponse.json(await mutateCart(id, user?.id ?? null, body.variantId, body.qty));
    await ensureCartCookie(response, id);
    return response;
  }
  if (root === "wishlist" && method === "GET") {
    const user = await requireUser();
    return NextResponse.json(await getWishlist(user.id));
  }
  if (root === "wishlist" && method === "POST") {
    guardMutation(request, "wishlist");
    const user = await requireUser();
    const body = z.object({ variantId: z.string().min(3).max(80) }).parse(await request.json());
    return NextResponse.json({ variantIds: await toggleWishlist(user.id, body.variantId) });
  }
  if (root === "auth" && second === "login" && method === "POST") {
    guardMutation(request, "login", 10);
    const body = z.object({ email: z.email(), password: z.string().min(1).max(128) }).parse(await request.json());
    const result = await login(body.email, body.password);
    const guest = await cartId();
    const nextCart = await mergeCart(guest, result.user.id);
    const response = NextResponse.json({ user: result.user });
    setSessionCookie(response, result.token);
    await ensureCartCookie(response, nextCart);
    return response;
  }
  if (root === "auth" && second === "logout" && method === "POST") {
    guardMutation(request, "logout");
    const jarToken = request.headers.get("cookie")?.match(/acme_session=([^;]+)/)?.[1];
    if (jarToken) await logout(decodeURIComponent(jarToken));
    const response = NextResponse.json({ ok: true });
    clearSessionCookie(response);
    return response;
  }
  if (root === "auth" && second === "recover" && method === "POST") {
    guardMutation(request, "recover", 5);
    const body = z.object({ email: z.email() }).parse(await request.json());
    let key = await mailKey();
    if (!key) key = randomToken(16);
    await requestReset(body.email, key);
    const response = NextResponse.json({
      message: "If an account exists for that email, password reset instructions have been sent.",
    });
    response.cookies.set(MAIL_COOKIE, key, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 30,
    });
    return response;
  }
  if (root === "auth" && second === "reset" && method === "POST") {
    guardMutation(request, "reset", 8);
    const body = z.object({ token: z.string().min(20).max(200), password: z.string().min(12).max(128) }).parse(await request.json());
    await resetPassword(body.token, body.password);
    return NextResponse.json({ ok: true });
  }
  if (root === "mail" && method === "GET") {
    const user = await readSession();
    return NextResponse.json(await demoMail(await mailKey(), user?.email));
  }
  if (root === "account" && method === "PATCH") {
    guardMutation(request, "account");
    const user = await requireUser();
    const body = z
      .object({
        fullName: z.string().min(2).max(80),
        phone: z.string().max(30),
        marketingOptIn: z.boolean(),
        address: addressSchema.optional(),
      })
      .parse(await request.json());
    return NextResponse.json(await saveProfile(user.id, body));
  }
  if (root === "account" && second === "password" && method === "POST") {
    guardMutation(request, "password", 8);
    const user = await requireUser();
    const body = z.object({ current: z.string().min(1).max(128), next: z.string().min(12).max(128) }).parse(await request.json());
    await changePassword(user.id, body.current, body.next);
    const response = NextResponse.json({ ok: true });
    clearSessionCookie(response);
    return response;
  }
  if (root === "checkout" && method === "POST" && !second) {
    guardMutation(request, "checkout", 12);
    const user = await requireUser();
    const body = z
      .object({
        couponCode: z.string().max(20).optional(),
        shippingMethod: z.enum(["standard", "express"]),
        address: addressSchema,
        scenario: z.enum(PAYMENT_SCENARIOS).optional(),
        provider: z.enum(["simulated", "stripe"]).optional(),
      })
      .parse(await request.json());
    const started = await startCheckout({
      userId: user.id,
      cartId: await cartId(),
      couponCode: body.couponCode,
      shippingMethod: body.shippingMethod,
      address: { ...body.address, country: body.address.country ?? "US" },
      scenario: body.scenario,
    });
    if (body.provider === "stripe") {
      const origin = new URL(request.url).origin;
      const url = await createStripeCheckout(started.checkout, origin);
      return NextResponse.json({ ...started, stripeUrl: url });
    }
    const order = await payCheckout(user.id, started.checkout.id);
    return NextResponse.json({ order });
  }
  if (root === "orders" && second && third === "authenticate" && method === "POST") {
    guardMutation(request, "pay", 10);
    const user = await requireUser();
    return NextResponse.json(await completeAuthentication(user.id, second));
  }
  if (root === "orders" && second && third === "cancel" && method === "POST") {
    guardMutation(request, "cancel");
    const user = await requireUser();
    return NextResponse.json(await cancelOrder(user, second));
  }
  if (root === "orders" && method === "GET" && !second) {
    const user = await requireUser();
    return NextResponse.json(await listOrders(user));
  }
  if (root === "orders" && method === "GET" && second) {
    const user = await requireUser();
    return NextResponse.json(await getOrder(user, second));
  }
  if (root === "returns" && method === "GET") {
    const user = await requireUser();
    return NextResponse.json(await listReturns(user));
  }
  if (root === "returns" && method === "POST") {
    guardMutation(request, "returns", 10);
    const user = await requireUser();
    const body = z
      .object({
        orderId: z.string().min(3).max(80),
        note: z.string().max(400),
        photoName: z.string().max(120).nullable().optional(),
        items: z.array(z.object({ variantId: z.string(), qty: z.number().int().min(1).max(10), reason: z.string().min(3).max(160) })).min(1).max(10),
      })
      .parse(await request.json());
    return NextResponse.json(await createReturn(user, { ...body, photoName: body.photoName ?? null }));
  }
  if (root === "uploads" && method === "POST") {
    guardMutation(request, "upload", 8);
    const user = await requireUser();
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new AppError("Choose an image to upload.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!isAllowedImage(bytes, file.name)) throw new AppError("Upload a PNG, JPEG, or WebP image under 2 MB.");
    const ext = bytes[0] === 0x89 ? "png" : bytes[0] === 0xff ? "jpg" : "webp";
    const name = `${user.id}-${randomToken(8)}.${ext}`;
    const admin = supabaseAdmin();
    if (admin) {
      const { error } = await admin.storage.from("return-photos").upload(name, bytes, {
        contentType: file.type,
        upsert: false,
      });
      if (error) throw new AppError("The file could not be stored.");
      return NextResponse.json({ name });
    }
    const dir = path.join(process.cwd(), ".data", "uploads");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, name), bytes);
    return NextResponse.json({ name });
  }
  if (root === "office" && second === "inventory" && method === "GET") {
    await requireArea("inventory");
    return NextResponse.json(await listInventory());
  }
  if (root === "office" && second === "inventory" && method === "POST") {
    guardMutation(request, "inventory");
    const user = await requireArea("inventory");
    const body = z.object({ variantId: z.string(), delta: z.number().int().min(-1000).max(1000) }).parse(await request.json());
    return NextResponse.json(await adjustStock(user, body.variantId, body.delta));
  }
  if (root === "office" && second === "products" && method === "POST") {
    guardMutation(request, "products");
    const user = await requireArea("products");
    const body = z
      .object({
        id: z.string().optional(),
        name: z.string().min(2).max(80),
        description: z.string().min(4).max(400),
        category: z.string().min(2).max(40),
        priceCents: z.number().int().min(50).max(500000),
        active: z.boolean(),
      })
      .parse(await request.json());
    return NextResponse.json(await saveProduct(user, body));
  }
  if (root === "office" && second === "orders" && method === "GET") {
    await requireArea("orders");
    return NextResponse.json(await officeOrders());
  }
  if (root === "office" && second === "orders" && fourth === "delivery" && method === "POST") {
    guardMutation(request, "delivery");
    const user = await requireArea("orders");
    const body = z.object({ status: z.enum(DELIVERY_STATUSES), trackingNumber: z.string().max(40).optional() }).parse(await request.json());
    return NextResponse.json(await updateDelivery(user, third, body.status, body.trackingNumber));
  }
  if (root === "office" && second === "refunds" && method === "GET") {
    await requireArea("refunds");
    return NextResponse.json(await listRefunds());
  }
  if (root === "office" && second === "refunds" && method === "POST") {
    guardMutation(request, "refunds", 12);
    const user = await requireArea("refunds");
    const body = z.object({ orderId: z.string(), amountCents: z.number().int().min(1), reason: z.string().min(3).max(200) }).parse(await request.json());
    return NextResponse.json(await refundOrder(user, body));
  }
  if (root === "scenarios" && method === "GET") {
    await requireArea("scenarios");
    return NextResponse.json({ settings: await getSettings(), events: await listEvents() });
  }
  if (root === "scenarios" && method === "POST") {
    guardMutation(request, "scenarios", 10);
    const user = await requireArea("scenarios");
    const body = z
      .object({
        action: z.enum(["advance", "reset", "settings"]),
        paymentScenario: z.enum(PAYMENT_SCENARIOS).optional(),
        authChallengeResult: z.enum(["approved", "declined"]).optional(),
      })
      .parse(await request.json());
    if (body.action === "advance") return NextResponse.json(await advanceSimulation(user));
    if (body.action === "reset") return NextResponse.json(await resetDemo(user));
    return NextResponse.json(await updateSettings(user, body));
  }
  if (root === "webhooks" && second === "stripe" && method === "POST") {
    const payload = await request.text();
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret || !verifyStripeSignature(payload, request.headers.get("stripe-signature"), secret)) {
      return NextResponse.json({ error: "Invalid Stripe signature." }, { status: 400 });
    }
    const event = JSON.parse(payload) as { type?: string; data?: { object?: { metadata?: { checkoutId?: string } } } };
    if (event.type === "checkout.session.completed" && event.data?.object?.metadata?.checkoutId) {
      await completeStripeCheckout(event.data.object.metadata.checkoutId);
    }
    return NextResponse.json({ received: true });
  }
  return NextResponse.json({ error: "Not found." }, { status: 404 });
}

async function entry(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  try {
    const { path: pathParts = [] } = await context.params;
    return await handle(request, pathParts);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Check the form and try again." }, { status: 400 });
    }
    return jsonError(error);
  }
}

export const GET = entry;
export const POST = entry;
export const PATCH = entry;
