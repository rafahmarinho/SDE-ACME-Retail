import type { DeliveryStatus } from "./types";

/** Delivery state machine enforced on the server (see updateDelivery). Cancellation goes through cancelOrder. */
export const DELIVERY_TRANSITIONS: Record<DeliveryStatus, DeliveryStatus[]> = {
  pending: [],
  processing: ["shipped"],
  shipped: ["out_for_delivery", "delivered"],
  out_for_delivery: ["delivered"],
  delivered: [],
  cancelled: [],
  return_requested: ["returned"],
  returned: [],
};
