/**
 * Privacy register and notice (SD Elements T178, T604, T754).
 *
 * Single source of truth for every activity that processes personal information: purpose,
 * categories of data, legal basis, whether it needs the user's opt-in (consent), whether the user
 * can object to it (restriction), retention and recipients. The privacy notice page, the consent
 * form, the consent and restriction toggles and the server-side checks (src/services/privacy.ts)
 * are all built from this list, so a new purpose cannot be used without appearing here.
 *
 * PRIVACY_NOTICE_VERSION changes whenever a purpose, data category, recipient or retention period
 * changes; consent given to an older version no longer counts and the user is asked again.
 * This module has no server-only imports: client pages render the notice from it.
 */
export const PRIVACY_NOTICE_VERSION = "2026-10-19";

export const PRIVACY_CONTACT = "privacy@acme-retail.test";

export type LegalBasis = "contract" | "consent" | "legitimate_interest" | "legal_obligation";

export interface ProcessingActivity {
  id: string;
  name: string;
  purpose: string;
  data: readonly string[];
  basis: LegalBasis;
  /** Needed to use the store; accepted together with the notice. */
  required: boolean;
  /** Runs only after the user opts in, and stops when consent is withdrawn. */
  consent: boolean;
  /** The user can object to it; a restricted activity stops for that user. */
  restrictable: boolean;
  retention: string;
  recipients: readonly string[];
}

export const PROCESSING_ACTIVITIES = [
  {
    id: "account",
    name: "Your account and sign-in",
    purpose: "Create and secure your account, sign you in and protect it against misuse.",
    data: ["e-mail address", "name", "password (stored only as a salted hash)", "sign-in and security events, including IP address"],
    basis: "contract",
    required: true,
    consent: false,
    restrictable: false,
    retention: "While your account exists. Security events are kept for 12 months.",
    recipients: ["Supabase (database hosting)", "Vercel (application hosting)"],
  },
  {
    id: "order_fulfilment",
    name: "Orders, delivery and returns",
    purpose: "Take your orders, ship them to you, handle cancellations, returns and refunds.",
    data: ["name", "shipping address", "order history", "return notes and photos"],
    basis: "contract",
    required: true,
    consent: false,
    restrictable: false,
    retention: "While your account exists and afterwards as long as tax and accounting law requires.",
    recipients: ["ACME Parcel (carrier)", "Stripe (payment test mode)", "Supabase (database and file storage)", "Vercel (application hosting)"],
  },
  {
    id: "delivery_phone",
    name: "Delivery contact by phone",
    purpose: "Let our warehouse give your phone number to the carrier so it can call you about a delivery.",
    data: ["phone number"],
    basis: "consent",
    required: false,
    consent: true,
    restrictable: true,
    retention: "Until you remove the number or withdraw this consent; it is then no longer shared.",
    recipients: ["ACME Parcel (carrier)"],
  },
  {
    id: "marketing_email",
    name: "Product update e-mails",
    purpose: "E-mail you when we add new products to the catalog.",
    data: ["e-mail address", "name"],
    basis: "consent",
    required: false,
    consent: true,
    restrictable: true,
    retention: "Until you withdraw this consent.",
    recipients: ["E-mail delivery provider"],
  },
  {
    id: "order_tracking_feed",
    name: "Live order tracking",
    purpose: "Mirror the status of your orders to a realtime feed so tracking pages update without reloading.",
    data: ["order number", "order status", "account id"],
    basis: "legitimate_interest",
    required: false,
    consent: false,
    restrictable: true,
    retention: "Replaced on every status change; removed when you restrict this activity.",
    recipients: ["Supabase (realtime feed)"],
  },
] as const satisfies readonly ProcessingActivity[];

export type ActivityId = (typeof PROCESSING_ACTIVITIES)[number]["id"];

type ConsentActivity = Extract<(typeof PROCESSING_ACTIVITIES)[number], { consent: true }>;
type RestrictableActivity = Extract<(typeof PROCESSING_ACTIVITIES)[number], { restrictable: true }>;

export type ConsentItemId = ConsentActivity["id"];
export type RestrictableId = RestrictableActivity["id"];

export const CONSENT_ITEMS = PROCESSING_ACTIVITIES.filter((activity): activity is ConsentActivity => activity.consent).map((activity) => activity.id);
export const RESTRICTABLE_ACTIVITIES = PROCESSING_ACTIVITIES.filter((activity): activity is RestrictableActivity => activity.restrictable).map((activity) => activity.id);

export function activity(id: ActivityId): ProcessingActivity {
  return PROCESSING_ACTIVITIES.find((item) => item.id === id)!;
}

/** Why each form field is collected and whether it is mandatory (shown next to the fields). */
export const FIELD_PURPOSES = {
  fullName: { required: true, why: "Printed on the shipping label so the carrier can deliver your order." },
  line1: { required: true, why: "Where we deliver your order." },
  city: { required: true, why: "Part of the delivery address." },
  region: { required: true, why: "Part of the delivery address; it also sets the sales tax." },
  postalCode: { required: true, why: "Part of the delivery address; the carrier sorts parcels by it." },
  phone: { required: false, why: "Optional. Shared with the carrier only if you allow delivery contact by phone on the Privacy page." },
} as const;

/** Concise summary shown above the detailed notice. */
export const NOTICE_SUMMARY = [
  "We use your name, e-mail and shipping address to run your account and deliver your orders.",
  "Optional uses (product update e-mails, delivery calls) happen only if you switch them on, and you can switch them off at any time.",
  "You can restrict optional uses of your data, including live order tracking, on the Privacy page of your account.",
  "We share data only with the services that host the store, deliver e-mail, process test payments and deliver parcels.",
  `Questions or requests: ${PRIVACY_CONTACT}.`,
];

/** Plain-language explanation of what consenting means and how to withdraw it. */
export const WITHDRAWAL_TEXT =
  "You can withdraw any consent or restrict an activity at any time on Account > Privacy. Withdrawing stops the activity from then on; it does not delete data we need for your orders.";
