export const ROLES = [
  "customer",
  "catalog",
  "warehouse",
  "finance",
  "administrator",
] as const;

export type Role = (typeof ROLES)[number];

export const PAYMENT_STATUSES = [
  "pending",
  "authentication_required",
  "approved",
  "declined",
  "timeout",
  "partially_refunded",
  "refunded",
  "cancelled",
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const DELIVERY_STATUSES = [
  "pending",
  "processing",
  "shipped",
  "out_for_delivery",
  "delivered",
  "cancelled",
  "return_requested",
  "returned",
] as const;

export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const PAYMENT_SCENARIOS = [
  "approved",
  "declined",
  "authentication_required",
  "timeout",
] as const;

export type PaymentScenario = (typeof PAYMENT_SCENARIOS)[number];

export type ShippingMethod = "standard" | "express";

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  fullName: string;
  role: Role;
  phone: string;
  failedLogins: number;
  lastFailedAt: string | null;
  lockouts: number;
  lockedUntil: string | null;
  mustChangePassword: boolean;
  passwordChangedAt: string | null;
  passwordHistory: string[];
  lastLoginAt: string | null;
  /** Second factor (TOTP). The secret is needed to verify codes; recovery codes are kept only as hashes. */
  mfa: { secret: string; enabledAt: string; lastCounter: number; recoveryCodeHashes: string[] } | null;
  /** Secret shown during enrollment, until the first valid code confirms it. */
  mfaPending: { secret: string; createdAt: string } | null;
  createdAt: string;
}

export interface Address {
  id: string;
  userId: string;
  fullName: string;
  line1: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  isDefault: boolean;
}

export interface Product {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  imageHue: number;
  active: boolean;
  featured: boolean;
  rating: number;
}

export interface Variant {
  id: string;
  productId: string;
  sku: string;
  label: string;
  options: Record<string, string>;
  priceCents: number;
  stock: number;
  reserved: number;
}

export interface Coupon {
  code: string;
  label: string;
  type: "percent" | "amount" | "shipping";
  value: number;
  minSubtotalCents: number;
  active: boolean;
}

export interface CartItem {
  variantId: string;
  qty: number;
}

export interface Cart {
  id: string;
  userId: string | null;
  items: CartItem[];
  updatedAt: string;
}

export interface Wishlist {
  userId: string;
  variantIds: string[];
}

export interface OrderItem {
  variantId: string;
  sku: string;
  productName: string;
  label: string;
  qty: number;
  unitPriceCents: number;
}

export interface OrderAddress {
  fullName: string;
  line1: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
}

export interface Order {
  id: string;
  number: string;
  userId: string;
  items: OrderItem[];
  couponCode: string | null;
  discountCents: number;
  shippingMethod: ShippingMethod;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  paymentStatus: PaymentStatus;
  deliveryStatus: DeliveryStatus;
  paymentScenario: PaymentScenario;
  address: OrderAddress;
  carrier: string | null;
  trackingNumber: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Reservation {
  id: string;
  checkoutId: string;
  userId: string;
  variantId: string;
  qty: number;
  unitPriceCents: number;
  expiresAt: string;
}

export interface CheckoutDraft {
  id: string;
  userId: string;
  cartId: string;
  items: OrderItem[];
  couponCode: string | null;
  discountCents: number;
  shippingMethod: ShippingMethod;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  address: OrderAddress;
  scenario: PaymentScenario;
  expiresAt: string;
  createdAt: string;
}

export interface ReturnItem {
  variantId: string;
  qty: number;
  reason: string;
}

export interface ReturnRequest {
  id: string;
  orderId: string;
  userId: string;
  items: ReturnItem[];
  status: "requested" | "approved" | "rejected" | "received" | "refunded";
  note: string;
  photoId: string | null;
  createdAt: string;
}

export interface Upload {
  id: string;
  userId: string;
  objectName: string;
  contentType: string;
  size: number;
  returnId: string | null;
  createdAt: string;
}

export interface Refund {
  id: string;
  orderId: string;
  amountCents: number;
  reason: string;
  partial: boolean;
  status: "completed" | "failed";
  actorId: string;
  createdAt: string;
}

export interface AppEvent {
  id: string;
  at: string;
  type: string;
  message: string;
  orderId: string | null;
  actorId: string | null;
  /** Audit chain (src/lib/audit.ts): hash of the previous event and of this one. */
  prevHash?: string;
  hash?: string;
}

export interface ResetToken {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

export interface Session {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  /** Last additional authentication (second factor or re-entered password) in this session. */
  stepUpAt: string | null;
}

/**
 * Privacy state of one account (src/services/privacy.ts): the notice decision, one consent entry
 * per consent item and the checklist of restricted activities.
 */
export interface PrivacyRecord {
  userId: string;
  /** Notice version the decision applies to; consent for an older version no longer counts. */
  noticeVersion: string | null;
  decision: "accepted" | "declined" | null;
  decidedAt: string | null;
  /** Language preference sent with the decision (BCP 47 tag). */
  language: string;
  consents: Record<string, { granted: boolean; at: string; noticeVersion: string }>;
  restrictions: Record<string, { restricted: boolean; at: string }>;
}

/** Append-only proof of every privacy decision: who, when, what, notice version and session. */
export interface ConsentEvent {
  id: string;
  userId: string;
  at: string;
  action: "accept" | "decline" | "grant" | "withdraw" | "restrict" | "lift_restriction";
  items: string[];
  noticeVersion: string;
  language: string;
  evidence: { sessionRef: string; ip: string; userAgent: string };
}

/** Anti-automation challenge for the password reset page (src/lib/pow.ts). */
export interface Challenge {
  id: string;
  salt: string;
  difficulty: number;
  expiresAt: string;
  usedAt: string | null;
}

export interface ThrottleCounter {
  key: string;
  count: number;
  resetAt: string;
}

export interface Settings {
  paymentScenario: PaymentScenario;
  authChallengeResult: "approved" | "declined";
  taxRateBps: number;
  reservationMinutes: number;
}

export interface StoreData {
  version: number;
  users: User[];
  addresses: Address[];
  products: Product[];
  variants: Variant[];
  coupons: Coupon[];
  carts: Cart[];
  wishlists: Wishlist[];
  orders: Order[];
  reservations: Reservation[];
  checkouts: CheckoutDraft[];
  returns: ReturnRequest[];
  refunds: Refund[];
  events: AppEvent[];
  uploads: Upload[];
  resetTokens: ResetToken[];
  sessions: Session[];
  privacy: PrivacyRecord[];
  consentLog: ConsentEvent[];
  /** Shared rate-limit counters (keys are hashes, never raw IPs or e-mail addresses). */
  throttle: ThrottleCounter[];
  challenges: Challenge[];
  settings: Settings;
  orderSeq: number;
}

export interface PublicUser {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  phone: string;
  mustChangePassword: boolean;
  mfaEnabled: boolean;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    phone: user.phone,
    mustChangePassword: Boolean(user.mustChangePassword),
    mfaEnabled: Boolean(user.mfa),
  };
}
