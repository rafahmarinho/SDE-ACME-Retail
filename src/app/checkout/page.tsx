"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { formatMoney } from "@/lib/money";
import { ErrorState, LoadingState } from "@/components/states";
import type { PaymentScenario } from "@/lib/types";
import { FIELD_PURPOSES } from "@/lib/privacy";
import { apiSend } from "@/lib/api-client";

type AddressField = "fullName" | "line1" | "city" | "region" | "postalCode";

/** Label that says whether the field is mandatory and why it is collected (also as a tooltip). */
function FieldLabel({ field, label, children }: { field: AddressField; label: string; children: ReactNode }) {
  const purpose = FIELD_PURPOSES[field];
  return (
    <label className="block text-sm" title={purpose.why}>
      {label} <span className="text-muted">({purpose.required ? "required" : "optional"})</span>
      {children}
      <span className="mt-1 block text-xs text-muted">{purpose.why}</span>
    </label>
  );
}

export default function CheckoutPage() {
  const router = useRouter();
  const [subtotal, setSubtotal] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [stripe, setStripe] = useState(false);
  const [scenario, setScenario] = useState<PaymentScenario>("approved");
  const [coupon, setCoupon] = useState("");
  const [method, setMethod] = useState<"standard" | "express">("standard");
  const [privacyAccepted, setPrivacyAccepted] = useState(false);

  useEffect(() => {
    Promise.all([fetch("/api/cart"), fetch("/api/session"), fetch("/api/account/privacy")]).then(async ([cartResponse, sessionResponse, privacyResponse]) => {
      const cart = await cartResponse.json();
      const session = await sessionResponse.json();
      const privacy = privacyResponse.ok ? await privacyResponse.json() : null;
      setSubtotal(cart.subtotalCents ?? 0);
      setStripe(Boolean(session.stripe));
      // Shipping details are collected only after the privacy notice is accepted (the server enforces it too).
      setPrivacyAccepted(Boolean(privacy?.accepted));
      if (!session.user) router.push("/login?next=/checkout");
      setReady(true);
    });
  }, [router]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const response = await apiSend("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        couponCode: coupon || undefined,
        shippingMethod: method,
        scenario,
        provider: form.get("provider") === "stripe" ? "stripe" : "simulated",
        address: {
          fullName: String(form.get("fullName")),
          line1: String(form.get("line1")),
          city: String(form.get("city")),
          region: String(form.get("region")),
          postalCode: String(form.get("postalCode")),
          country: "US",
        },
      }),
    });
    const body = await response.json();
    setLoading(false);
    if (!response.ok) {
      setError(body.error ?? "Checkout could not be completed.");
      return;
    }
    if (body.stripeUrl) {
      window.location.href = body.stripeUrl;
      return;
    }
    window.dispatchEvent(new Event("acme-cart"));
    router.push(`/payment/result?order=${body.order.id}`);
  }

  if (!ready) return <LoadingState label="Preparing checkout..." />;
  if (!privacyAccepted) {
    return (
      <section className="panel mx-auto max-w-xl space-y-3 p-6">
        <h1 className="text-2xl font-semibold">Before we ask for your address</h1>
        <p className="text-sm">We need your name and shipping address to deliver the order. Review the privacy notice and decide on the optional uses of your information first.</p>
        <Link className="btn" href="/account/privacy?next=/checkout">Review and decide</Link>
      </section>
    );
  }
  const shipping = method === "express" ? 1495 : subtotal >= 7500 || coupon.toUpperCase() === "FREESHIP" ? 0 : 595;
  const discount = coupon.toUpperCase() === "WELCOME10" ? Math.round(subtotal * 0.1) : coupon.toUpperCase() === "SAVE5" && subtotal >= 2000 ? 500 : 0;
  const tax = Math.round((subtotal - discount) * 0.0825);

  return (
    <form className="grid gap-6 md:grid-cols-[1.3fr_.7fr]" onSubmit={(event) => void submit(event)}>
      <div className="panel space-y-3 p-5">
        <h1 className="text-2xl font-semibold">Checkout</h1>
        <p className="text-sm text-muted">Stock is reserved for 15 minutes. The price shown here is the price saved on the order.</p>
        {error ? <ErrorState message={error} /> : null}
        <FieldLabel field="fullName" label="Full name"><input className="field mt-1" name="fullName" required /></FieldLabel>
        <FieldLabel field="line1" label="Street address"><input className="field mt-1" name="line1" required /></FieldLabel>
        <div className="grid gap-3 sm:grid-cols-3">
          <FieldLabel field="city" label="City"><input className="field mt-1" name="city" required /></FieldLabel>
          <FieldLabel field="region" label="State"><input className="field mt-1" name="region" defaultValue="CA" required /></FieldLabel>
          <FieldLabel field="postalCode" label="Postal code"><input className="field mt-1" name="postalCode" required /></FieldLabel>
        </div>
        <label className="block text-sm">Shipping
          <select className="field mt-1" value={method} onChange={(event) => setMethod(event.target.value as "standard" | "express")}>
            <option value="standard">Standard, 5 days</option>
            <option value="express">Express, 2 days</option>
          </select>
        </label>
        <label className="block text-sm">Coupon
          <input className="field mt-1" value={coupon} onChange={(event) => setCoupon(event.target.value)} placeholder="WELCOME10" />
        </label>
        <label className="block text-sm">Simulated payment outcome
          <select className="field mt-1" value={scenario} onChange={(event) => setScenario(event.target.value as PaymentScenario)}>
            <option value="approved">Approved</option>
            <option value="declined">Declined</option>
            <option value="authentication_required">Authentication required</option>
            <option value="timeout">Timeout</option>
          </select>
        </label>
        <div className="flex flex-wrap gap-2">
          <button className="btn" name="provider" value="simulated" disabled={loading}>{loading ? "Placing order..." : "Place simulated order"}</button>
          {stripe ? <button className="btn secondary" name="provider" value="stripe">Stripe test checkout</button> : null}
        </div>
      </div>
      <aside className="panel h-fit space-y-2 p-5">
        <h2 className="font-semibold">Illustrative totals</h2>
        <p className="flex justify-between"><span>Subtotal</span><span>{formatMoney(subtotal)}</span></p>
        <p className="flex justify-between"><span>Discount</span><span>-{formatMoney(discount)}</span></p>
        <p className="flex justify-between"><span>Shipping</span><span>{formatMoney(shipping)}</span></p>
        <p className="flex justify-between"><span>Tax (8.25%)</span><span>{formatMoney(Math.max(0, tax))}</span></p>
        <p className="flex justify-between font-semibold"><span>Total</span><span>{formatMoney(Math.max(0, subtotal - discount) + shipping + Math.max(0, tax))}</span></p>
        <p className="text-xs text-muted">The server recalculates these amounts. Card numbers are not collected.</p>
      </aside>
    </form>
  );
}
