import type { Role } from "./types";

/**
 * Central access-control policy. Every authorization decision of the API routes, the services and
 * the page proxy is taken here; no other module compares roles (see src/lib/policy.test.ts).
 *
 * Separation of duties (NIST SP 800-192). Critical functions and the single role that performs each:
 * - recording of catalog data and prices ........ catalog.manage ................. catalog
 * - custody of goods (stock and shipments) ...... inventory.adjust, orders.fulfil . warehouse
 * - authorization of money out (refunds, staff
 *   cancellations that refund) .................. refunds.issue, orders.cancel_any  finance
 * - verification (read-only oversight, audit log)
 *   and the simulation settings ................. *.view, events.view, scenarios.manage  administrator
 * - placing orders .............................. orders.purchase ................ customer
 * No role holds two conflicting duties, staff accounts cannot buy, and nobody may refund or
 * cancel-with-refund an order they placed (checked per object below).
 */
export const PERMISSIONS = [
  "orders.purchase",
  "catalog.manage",
  "inventory.view",
  "inventory.adjust",
  "orders.view",
  "orders.fulfil",
  "orders.cancel_any",
  "refunds.view",
  "refunds.issue",
  "scenarios.manage",
  "events.view",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const GRANTS: Record<Role, readonly Permission[]> = {
  customer: ["orders.purchase"],
  catalog: ["catalog.manage"],
  warehouse: ["inventory.view", "inventory.adjust", "orders.view", "orders.fulfil"],
  finance: ["orders.view", "orders.cancel_any", "refunds.view", "refunds.issue"],
  administrator: ["scenarios.manage", "events.view", "orders.view", "inventory.view", "refunds.view"],
};

/** Duties that must never be combined in one role. */
export const CONFLICTING_DUTIES: readonly (readonly Permission[])[] = [
  ["orders.purchase", "refunds.issue"],
  ["orders.purchase", "orders.cancel_any"],
  ["catalog.manage", "refunds.issue"],
  ["inventory.adjust", "refunds.issue"],
  ["orders.fulfil", "refunds.issue"],
  ["catalog.manage", "inventory.adjust"],
  ["scenarios.manage", "refunds.issue"],
  ["scenarios.manage", "inventory.adjust"],
  ["scenarios.manage", "orders.fulfil"],
  ["scenarios.manage", "catalog.manage"],
];

export function can(role: Role | undefined | null, permission: Permission): boolean {
  if (!role) return false;
  return GRANTS[role]?.includes(permission) ?? false;
}

export function permissionsOf(role: Role): Permission[] {
  return [...(GRANTS[role] ?? [])];
}

export function isStaff(role: Role): boolean {
  return permissionsOf(role).some((permission) => permission !== "orders.purchase");
}

interface Actor {
  id: string;
  role: Role;
}

interface OwnedObject {
  userId: string;
}

/** Owners see their own orders; other accounts need the orders.view duty. */
export function canViewOrder(actor: Actor, order: OwnedObject): boolean {
  return order.userId === actor.id || can(actor.role, "orders.view");
}

/** Owners cancel their own orders; a staff cancellation refunds money, so it is a finance duty. */
export function canCancelOrder(actor: Actor, order: OwnedObject): boolean {
  if (order.userId === actor.id) return true;
  return can(actor.role, "orders.cancel_any");
}

/** Refunds need the refunds.issue duty and are never allowed on the actor's own order. */
export function canRefundOrder(actor: Actor, order: OwnedObject): boolean {
  return can(actor.role, "refunds.issue") && order.userId !== actor.id;
}

/** Only the customer who placed an order can open a return for it. */
export function canRequestReturn(actor: Actor, order: OwnedObject): boolean {
  return order.userId === actor.id && can(actor.role, "orders.purchase");
}

export function canViewReturn(actor: Actor, item: OwnedObject): boolean {
  return item.userId === actor.id || can(actor.role, "orders.view");
}

/**
 * Order fields each viewer may receive (data minimization per duty). The customer's phone goes only
 * to fulfilment, and only while the customer allows delivery contact (checked in the service).
 */
export function orderFieldsFor(actor: Actor, order: OwnedObject) {
  const own = order.userId === actor.id;
  return {
    address: own || can(actor.role, "orders.fulfil"),
    contactPhone: !own && can(actor.role, "orders.fulfil"),
    refunds: own || can(actor.role, "refunds.view"),
    returns: own || can(actor.role, "orders.view"),
    events: own || can(actor.role, "orders.view"),
  };
}

export type Access = "public" | "user" | "staff" | Permission;

export interface ApiRoute {
  method: "GET" | "POST" | "PATCH";
  path: string;
  access: Access;
  /** Public routes that still read the optional session. */
  optionalUser?: boolean;
  /** Routes a user may call before changing a mandatory password. */
  allowDuringPasswordChange?: boolean;
  /**
   * Critical requests that involve personal or financial data need a recent additional
   * authentication (second factor, or the password for customers without one): "always", or
   * "staff" when only a staff caller makes the request critical (e.g. a cancellation that refunds).
   */
  stepUp?: "always" | "staff";
}

/**
 * Explicit allow-list of API routes. Anything not listed here is answered with 404 before any
 * handler runs (deny by default), and each listed route declares who may call it.
 */
export const API_ROUTES: readonly ApiRoute[] = [
  { method: "GET", path: "session", access: "public", optionalUser: true, allowDuringPasswordChange: true },
  { method: "GET", path: "catalog", access: "public" },
  { method: "GET", path: "products/:slug", access: "public" },
  { method: "GET", path: "cart", access: "public" },
  { method: "POST", path: "cart", access: "public", optionalUser: true },
  { method: "POST", path: "auth/login", access: "public" },
  { method: "POST", path: "auth/logout", access: "public" },
  { method: "POST", path: "auth/challenge", access: "public" },
  { method: "POST", path: "auth/recover", access: "public" },
  { method: "POST", path: "auth/reset", access: "public" },
  { method: "POST", path: "auth/step-up", access: "user" },
  { method: "POST", path: "webhooks/stripe", access: "public" },
  { method: "POST", path: "csp-report", access: "public" },
  { method: "GET", path: "wishlist", access: "user" },
  { method: "POST", path: "wishlist", access: "user" },
  { method: "PATCH", path: "account", access: "user", stepUp: "always" },
  { method: "POST", path: "account/password", access: "user", allowDuringPasswordChange: true },
  { method: "GET", path: "account/privacy", access: "user" },
  { method: "POST", path: "account/privacy", access: "user" },
  { method: "PATCH", path: "account/privacy/consents", access: "user" },
  { method: "PATCH", path: "account/privacy/restrictions", access: "user" },
  { method: "POST", path: "account/mfa/setup", access: "user" },
  { method: "POST", path: "account/mfa/enable", access: "user" },
  { method: "POST", path: "account/mfa/disable", access: "user", stepUp: "always" },
  { method: "POST", path: "checkout", access: "orders.purchase" },
  { method: "POST", path: "orders/:id/authenticate", access: "user" },
  { method: "POST", path: "orders/:id/cancel", access: "user", stepUp: "staff" },
  { method: "GET", path: "orders", access: "user" },
  { method: "GET", path: "orders/:id", access: "user" },
  { method: "GET", path: "returns", access: "user" },
  { method: "POST", path: "returns", access: "orders.purchase" },
  { method: "POST", path: "uploads", access: "orders.purchase" },
  { method: "GET", path: "office/inventory", access: "inventory.view" },
  { method: "POST", path: "office/inventory", access: "inventory.adjust" },
  { method: "POST", path: "office/products", access: "catalog.manage" },
  { method: "POST", path: "office/products/:id/announce", access: "catalog.manage", stepUp: "always" },
  { method: "GET", path: "office/orders", access: "orders.view" },
  { method: "POST", path: "office/orders/:id/delivery", access: "orders.fulfil" },
  { method: "GET", path: "office/refunds", access: "refunds.view" },
  { method: "POST", path: "office/refunds", access: "refunds.issue", stepUp: "always" },
  { method: "GET", path: "scenarios", access: "scenarios.manage" },
  { method: "GET", path: "office/audit", access: "events.view" },
  { method: "POST", path: "scenarios", access: "scenarios.manage", stepUp: "always" },
];

function partsMatch(segments: string[], parts: string[]): boolean {
  if (segments.length !== parts.length) return false;
  return segments.every((segment, index) => segment.startsWith(":") || segment === parts[index]);
}

function matches(pattern: string, parts: string[]): boolean {
  return partsMatch(pattern.split("/"), parts);
}

export function matchApiRoute(method: string, parts: string[]): ApiRoute | null {
  return API_ROUTES.find((route) => route.method === method && matches(route.path, parts)) ?? null;
}

/** Pages anyone may open without signing in. Every other page requires a session. */
export const PUBLIC_PAGES: readonly string[] = ["/", "/catalog", "/product/:slug", "/cart", "/login", "/recover", "/reset", "/privacy"];

export const PROTECTED_PAGES: readonly { path: string; access: Access }[] = [
  { path: "/account", access: "user" },
  { path: "/account/profile", access: "user" },
  { path: "/account/privacy", access: "user" },
  { path: "/account/settings", access: "user" },
  { path: "/account/orders", access: "user" },
  { path: "/account/orders/:id", access: "user" },
  { path: "/account/returns", access: "user" },
  { path: "/wishlist", access: "user" },
  { path: "/payment/result", access: "user" },
  { path: "/checkout", access: "orders.purchase" },
  { path: "/office", access: "staff" },
  { path: "/office/products", access: "catalog.manage" },
  { path: "/office/inventory", access: "inventory.view" },
  { path: "/office/orders", access: "orders.view" },
  { path: "/office/refunds", access: "refunds.view" },
  { path: "/office/scenarios", access: "scenarios.manage" },
  { path: "/office/audit", access: "events.view" },
];

function pageParts(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

function pageMatches(pattern: string, pathname: string): boolean {
  return partsMatch(pageParts(pattern), pageParts(pathname));
}

/** Access rule for a page path; unknown pages require a session (deny by default). */
export function pageAccess(pathname: string): Access {
  const clean = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (PUBLIC_PAGES.some((pattern) => pageMatches(pattern, clean))) return "public";
  return PROTECTED_PAGES.find((page) => pageMatches(page.path, clean))?.access ?? "user";
}

export function isKnownPage(pathname: string): boolean {
  return PUBLIC_PAGES.some((pattern) => pageMatches(pattern, pathname)) || PROTECTED_PAGES.some((page) => pageMatches(page.path, pathname));
}

/** Whether this request is critical for this actor and needs a recent additional authentication. */
export function stepUpRequired(route: ApiRoute, actor: Actor): boolean {
  return route.stepUp === "always" || (route.stepUp === "staff" && isStaff(actor.role));
}

/** Staff accounts must use a second factor for additional authentication; customers may use their password. */
export function requiresSecondFactor(role: Role): boolean {
  return isStaff(role);
}

/** Decides whether an actor satisfies an access rule. */
export function allows(access: Access, actor: Actor | null): boolean {
  if (access === "public") return true;
  if (!actor) return false;
  if (access === "user") return true;
  if (access === "staff") return isStaff(actor.role);
  return can(actor.role, access);
}

/** Back-office landing page for a role (first area it can open). */
export function officeHome(role: Role): string | null {
  const order: [Permission, string][] = [
    ["catalog.manage", "/office/products"],
    ["inventory.adjust", "/office/inventory"],
    ["refunds.issue", "/office/refunds"],
    ["scenarios.manage", "/office/scenarios"],
    ["orders.view", "/office/orders"],
  ];
  return order.find(([permission]) => can(role, permission))?.[1] ?? null;
}
