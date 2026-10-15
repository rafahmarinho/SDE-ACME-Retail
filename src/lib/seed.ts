import { hashSecret } from "./security";
import type { Address, Order, Product, Role, StoreData, User, Variant } from "./types";

const DEMO_PASSWORD = "Retail123!";

interface CatalogSeed {
  name: string;
  category: string;
  description: string;
  price: number;
  featured?: boolean;
  options?: { name: string; values: string[] }[];
}

const CATALOG: CatalogSeed[] = [
  { name: "Merino Crew Tee", category: "Apparel", description: "Lightweight merino tee for everyday wear.", price: 4800, featured: true, options: [{ name: "Size", values: ["S", "M", "L"] }, { name: "Color", values: ["Forest", "Charcoal"] }] },
  { name: "Canvas Market Tote", category: "Apparel", description: "Heavy canvas tote with an interior pocket.", price: 3600, featured: true, options: [{ name: "Color", values: ["Natural", "Olive"] }] },
  { name: "Wool Beanie", category: "Apparel", description: "Ribbed wool beanie with a soft lining.", price: 2800, options: [{ name: "Color", values: ["Forest", "Oat"] }] },
  { name: "Denim Jacket", category: "Apparel", description: "Unlined denim jacket with a relaxed fit.", price: 12800, featured: true, options: [{ name: "Size", values: ["S", "M", "L", "XL"] }] },
  { name: "Fleece Vest", category: "Apparel", description: "Warm fleece vest for layering.", price: 7400, options: [{ name: "Size", values: ["S", "M", "L"] }] },
  { name: "Leather Belt", category: "Apparel", description: "Full-grain belt with a brushed buckle.", price: 5400, options: [{ name: "Size", values: ["32", "34", "36"] }] },
  { name: "Running Socks 3-Pack", category: "Apparel", description: "Cushioned crew socks in a three-pack.", price: 2200, options: [{ name: "Size", values: ["S", "M", "L"] }] },
  { name: "Weekender Duffel", category: "Apparel", description: "Structured duffel for short trips.", price: 15800, featured: true, options: [{ name: "Color", values: ["Charcoal", "Sand"] }] },
  { name: "Sunglasses", category: "Apparel", description: "Polarized lenses in a lightweight frame.", price: 8900, options: [{ name: "Color", values: ["Tortoise", "Black"] }] },
  { name: "Stoneware Mug", category: "Home", description: "12 oz mug with a matte glaze.", price: 1800, featured: true, options: [{ name: "Color", values: ["Sage", "White"] }] },
  { name: "Linen Throw", category: "Home", description: "Washed linen throw for the sofa.", price: 6800, options: [{ name: "Color", values: ["Oat", "Forest"] }] },
  { name: "Ceramic Planter", category: "Home", description: "Drainage-ready planter for indoor plants.", price: 3200, options: [{ name: "Size", values: ["Small", "Medium"] }] },
  { name: "Scented Candle", category: "Home", description: "Cedar and fig soy candle.", price: 2600, options: [{ name: "Size", values: ["8 oz", "14 oz"] }] },
  { name: "Cotton Sheet Set", category: "Home", description: "Percale sheet set, queen size.", price: 11200, options: [{ name: "Color", values: ["White", "Stone"] }] },
  { name: "Bamboo Bath Towel", category: "Home", description: "Absorbent towel with a tight weave.", price: 2900, options: [{ name: "Color", values: ["Sage", "Sand"] }] },
  { name: "Oak Cutting Board", category: "Kitchen", description: "Edge-grain board with a juice groove.", price: 6400, featured: true },
  { name: "Cast Iron Skillet", category: "Kitchen", description: "Pre-seasoned 10-inch skillet.", price: 4900 },
  { name: "Glass Carafe", category: "Kitchen", description: "Heat-safe carafe for water or coffee.", price: 3400 },
  { name: "Pour-over Kettle", category: "Kitchen", description: "Gooseneck kettle with a thermometer.", price: 7200, featured: true },
  { name: "Espresso Cup Set", category: "Kitchen", description: "Set of four demitasse cups.", price: 3800 },
  { name: "LED Desk Lamp", category: "Electronics", description: "Dimmable lamp with a warm-to-cool range.", price: 5900, featured: true },
  { name: "Wireless Earbuds", category: "Electronics", description: "Noise-isolating earbuds with a charging case.", price: 7900, options: [{ name: "Color", values: ["Black", "White"] }] },
  { name: "Bluetooth Speaker", category: "Electronics", description: "Compact speaker with a 12-hour battery.", price: 6900 },
  { name: "Laptop Sleeve", category: "Electronics", description: "Padded 14-inch sleeve.", price: 4200, options: [{ name: "Color", values: ["Charcoal", "Olive"] }] },
  { name: "Mechanical Keyboard", category: "Electronics", description: "Low-profile keyboard with quiet switches.", price: 11900, featured: true },
  { name: "Trail Water Bottle", category: "Outdoors", description: "Insulated 24 oz bottle.", price: 3200, options: [{ name: "Color", values: ["Forest", "Sand"] }] },
  { name: "Yoga Mat", category: "Outdoors", description: "5 mm mat with a textured surface.", price: 4500, options: [{ name: "Color", values: ["Sage", "Charcoal"] }] },
  { name: "Hiking Poles", category: "Outdoors", description: "Collapsible aluminum poles, sold as a pair.", price: 6400 },
  { name: "Garden Shears", category: "Outdoors", description: "Bypass shears with a locking clasp.", price: 2800 },
  { name: "Stainless Bottle", category: "Outdoors", description: "32 oz bottle with a straw lid.", price: 3600 },
  { name: "Face Moisturizer", category: "Beauty", description: "Unscented daily moisturizer, 50 ml.", price: 2400, featured: true },
  { name: "Lip Balm", category: "Beauty", description: "Beeswax balm in a tin.", price: 800 },
  { name: "Hand Soap Set", category: "Beauty", description: "Three refillable soap bottles.", price: 2200 },
  { name: "Olive Oil 500ml", category: "Grocery", description: "Cold-pressed extra virgin olive oil.", price: 1600 },
  { name: "Dark Roast Coffee", category: "Grocery", description: "12 oz whole-bean dark roast.", price: 1400, featured: true },
  { name: "Wildflower Honey", category: "Grocery", description: "12 oz jar of wildflower honey.", price: 1200 },
  { name: "Toasted Granola", category: "Grocery", description: "Almond and oat granola, 11 oz.", price: 900 },
  { name: "Chamomile Tea", category: "Grocery", description: "Caffeine-free tea, 20 bags.", price: 800 },
  { name: "Sea Salt Crackers", category: "Grocery", description: "Crisp crackers baked with sea salt.", price: 600 },
  { name: "Maple Syrup 250ml", category: "Grocery", description: "Grade A maple syrup.", price: 1500 },
];

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function mulberry32(seed: number) {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildCatalog(): { products: Product[]; variants: Variant[] } {
  const products: Product[] = [];
  const variants: Variant[] = [];
  CATALOG.forEach((item, index) => {
    const id = `prd_${String(index + 1).padStart(2, "0")}`;
    products.push({
      id,
      slug: slugify(item.name),
      name: item.name,
      description: item.description,
      category: item.category,
      imageHue: (index * 37) % 140,
      active: true,
      featured: Boolean(item.featured),
      rating: 4 + ((index % 5) * 0.1),
    });
    const groups = item.options ?? [{ name: "Option", values: ["Standard"] }];
    const combos = groups.reduce<Record<string, string>[]>(
      (acc, group) =>
        acc.flatMap((current) => group.values.map((value) => ({ ...current, [group.name]: value }))),
      [{}],
    );
    combos.forEach((options, variantIndex) => {
      const label = Object.values(options).join(" / ");
      variants.push({
        id: `${id}_v${variantIndex + 1}`,
        productId: id,
        sku: `AC-${String(index + 1).padStart(3, "0")}-${variantIndex + 1}`,
        label,
        options,
        priceCents: item.price + variantIndex * 200,
        stock: 24 + ((index + variantIndex) % 17),
        reserved: 0,
      });
    });
  });
  return { products, variants };
}

function user(id: string, email: string, fullName: string, role: Role, at: string): User {
  return {
    id,
    email,
    passwordHash: hashSecret(DEMO_PASSWORD),
    fullName,
    role,
    phone: "",
    marketingOptIn: false,
    failedLogins: 0,
    lockedUntil: null,
    createdAt: at,
  };
}

function address(userId: string, fullName: string, city: string): Address {
  return {
    id: `addr_${userId}`,
    userId,
    fullName,
    line1: "18 Market Street",
    city,
    region: "CA",
    postalCode: "94105",
    country: "US",
    isDefault: true,
  };
}

function buildOrders(
  products: Product[],
  variants: Variant[],
  customerIds: string[],
): Order[] {
  const rand = mulberry32(20261012);
  const pick = <T,>(items: T[]) => items[Math.floor(rand() * items.length)];
  const paymentCycle = [
    "approved",
    "approved",
    "approved",
    "approved",
    "declined",
    "authentication_required",
    "timeout",
    "partially_refunded",
    "refunded",
    "cancelled",
  ] as const;
  const deliveryFor = (payment: (typeof paymentCycle)[number], index: number) => {
    if (payment === "declined" || payment === "timeout" || payment === "authentication_required") return "pending" as const;
    if (payment === "cancelled") return "cancelled" as const;
    if (payment === "refunded") return index % 2 === 0 ? "returned" as const : "delivered" as const;
    const flow = ["processing", "shipped", "out_for_delivery", "delivered"] as const;
    return flow[index % flow.length];
  };
  const orders: Order[] = [];
  for (let i = 0; i < 60; i += 1) {
    const paymentStatus = paymentCycle[i % paymentCycle.length];
    const deliveryStatus = deliveryFor(paymentStatus, i);
    const variant = variants[i % variants.length];
    const product = products.find((item) => item.id === variant.productId)!;
    const qty = 1 + (i % 3);
    const unitPriceCents = variant.priceCents;
    const subtotal = unitPriceCents * qty;
    const discountCents = i % 7 === 0 ? Math.round(subtotal * 0.1) : 0;
    const shippingCents = subtotal - discountCents >= 7500 ? 0 : 595;
    const taxCents = Math.round((subtotal - discountCents) * 0.0825);
    const created = new Date(Date.UTC(2026, 7, 1 + (i % 28), 14, i % 60)).toISOString();
    orders.push({
      id: `ord_${String(i + 1).padStart(3, "0")}`,
      number: `AR-${10001 + i}`,
      userId: customerIds[i % customerIds.length],
      items: [
        {
          variantId: variant.id,
          sku: variant.sku,
          productName: product.name,
          label: variant.label,
          qty,
          unitPriceCents,
        },
      ],
      couponCode: discountCents ? "WELCOME10" : null,
      discountCents,
      shippingMethod: i % 5 === 0 ? "express" : "standard",
      shippingCents: i % 5 === 0 ? 1495 : shippingCents,
      taxCents,
      totalCents: subtotal - discountCents + (i % 5 === 0 ? 1495 : shippingCents) + taxCents,
      paymentStatus,
      deliveryStatus,
      paymentScenario:
        paymentStatus === "declined" ||
        paymentStatus === "timeout" ||
        paymentStatus === "authentication_required"
          ? paymentStatus
          : "approved",
      address: {
        fullName: "Demo Customer",
        line1: `${10 + i} Market Street`,
        city: "San Francisco",
        region: "CA",
        postalCode: "94105",
        country: "US",
      },
      carrier: deliveryStatus === "pending" || deliveryStatus === "processing" || deliveryStatus === "cancelled" ? null : "ACME Parcel",
      trackingNumber:
        deliveryStatus === "pending" || deliveryStatus === "processing" || deliveryStatus === "cancelled"
          ? null
          : `1ZACME${String(100000 + i)}`,
      createdAt: created,
      updatedAt: created,
    });
    void pick;
  }
  return orders;
}

export const DEMO_ACCOUNTS = [
  { email: "customer@acme-retail.test", role: "customer", name: "Avery Chen" },
  { email: "catalog@acme-retail.test", role: "catalog", name: "Morgan Blake" },
  { email: "warehouse@acme-retail.test", role: "warehouse", name: "Riley Ortiz" },
  { email: "finance@acme-retail.test", role: "finance", name: "Quinn Adeyemi" },
  { email: "admin@acme-retail.test", role: "administrator", name: "Jordan Hale" },
  { email: "jordan.lee@acme-retail.test", role: "customer", name: "Jordan Lee" },
  { email: "sam.patel@acme-retail.test", role: "customer", name: "Sam Patel" },
] as const;

export function buildSeed(): StoreData {
  const now = "2026-08-01T12:00:00.000Z";
  const users = DEMO_ACCOUNTS.map((account, index) =>
    user(`usr_${String(index + 1).padStart(2, "0")}`, account.email, account.name, account.role, now),
  );
  const { products, variants } = buildCatalog();
  const customerIds = users.filter((item) => item.role === "customer").map((item) => item.id);
  return {
    version: 1,
    users,
    addresses: users
      .filter((item) => item.role === "customer")
      .map((item) => address(item.id, item.fullName, "San Francisco")),
    products,
    variants,
    coupons: [
      { code: "WELCOME10", label: "10% off", type: "percent", value: 10, minSubtotalCents: 0, active: true },
      { code: "SAVE5", label: "$5 off", type: "amount", value: 500, minSubtotalCents: 2000, active: true },
      { code: "FREESHIP", label: "Free standard shipping", type: "shipping", value: 0, minSubtotalCents: 0, active: true },
      { code: "OLD20", label: "Expired 20% off", type: "percent", value: 20, minSubtotalCents: 0, active: false },
    ],
    carts: [],
    wishlists: [],
    orders: buildOrders(products, variants, customerIds),
    reservations: [],
    checkouts: [],
    returns: [],
    refunds: [],
    events: [
      {
        id: "evt_seed",
        at: now,
        type: "seed",
        message: "Demo catalog and order history loaded.",
        orderId: null,
        actorId: null,
      },
    ],
    mail: [],
    resetTokens: [],
    sessions: [],
    settings: {
      paymentScenario: "approved",
      authChallengeResult: "approved",
      taxRateBps: 825,
      reservationMinutes: 15,
    },
    orderSeq: 10060,
  };
}

export const DEMO_PASSWORD_HINT = DEMO_PASSWORD;
