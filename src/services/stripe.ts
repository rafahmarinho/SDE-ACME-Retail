import type { CheckoutDraft } from "../lib/types";

export function stripeTestConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_"));
}

export async function createStripeCheckout(draft: CheckoutDraft, origin: string) {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret?.startsWith("sk_test_")) {
    throw new Error("Stripe test mode is not configured.");
  }
  const body = new URLSearchParams();
  body.set("mode", "payment");
  body.set("success_url", `${origin}/payment/result?provider=stripe&session_id={CHECKOUT_SESSION_ID}`);
  body.set("cancel_url", `${origin}/checkout?cancelled=1`);
  body.set("client_reference_id", draft.id);
  body.set("metadata[checkoutId]", draft.id);
  draft.items.forEach((item, index) => {
    body.set(`line_items[${index}][quantity]`, String(item.qty));
    body.set(`line_items[${index}][price_data][currency]`, "usd");
    body.set(`line_items[${index}][price_data][unit_amount]`, String(item.unitPriceCents));
    body.set(`line_items[${index}][price_data][product_data][name]`, `${item.productName} (${item.label})`);
  });
  const shippingIndex = draft.items.length;
  if (draft.shippingCents > 0) {
    body.set(`line_items[${shippingIndex}][quantity]`, "1");
    body.set(`line_items[${shippingIndex}][price_data][currency]`, "usd");
    body.set(`line_items[${shippingIndex}][price_data][unit_amount]`, String(draft.shippingCents + draft.taxCents));
    body.set(`line_items[${shippingIndex}][price_data][product_data][name]`, "Illustrative shipping and tax");
  }
  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const payload = (await response.json()) as { url?: string; error?: { message?: string } };
  if (!response.ok || !payload.url) {
    throw new Error(payload.error?.message ?? "Stripe did not return a checkout URL.");
  }
  return payload.url;
}
