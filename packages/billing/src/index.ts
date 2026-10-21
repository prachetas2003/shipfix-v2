import { createHmac, timingSafeEqual } from "node:crypto";

/** Guardian is one price per app. A cheaper first paid tier was rejected for this product. */
export const GUARDIAN_PRICE_CENTS = 2900;

export interface PlanOffer {
  id: "free" | "guardian" | "agency";
  name: string;
  /** Null when this build cannot charge for the plan. */
  priceCents: number | null;
  checkout: boolean;
  summary: string;
}

export const PLAN_OFFERS: PlanOffer[] = [
  {
    id: "free",
    name: "Free",
    priceCents: 0,
    checkout: false,
    summary: "Deploy, fix, and the launch readiness check.",
  },
  {
    id: "guardian",
    name: "Guardian",
    priceCents: GUARDIAN_PRICE_CENTS,
    checkout: true,
    summary: "Health checks, rollback, spend caps, backups, and a custom domain for one app.",
  },
  {
    id: "agency",
    name: "Agency",
    priceCents: null,
    checkout: false,
    summary: "Multiple workspaces and handing an app to a client. Workspaces are not in this build, so Agency has no checkout.",
  },
];

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function guardianEntitled(plan: string | null | undefined, status: string | null | undefined): boolean {
  return plan === "guardian" && (status === "active" || status === "trialing");
}

export function verifyStripeSignature(
  raw: string,
  header: string | undefined,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (!header || !secret) return false;
  const timestamp = header.split(",").find((part) => part.startsWith("t="))?.slice(2);
  if (!timestamp || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowSec - Number(timestamp)) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
  return header.split(",").some((part) => {
    if (!part.startsWith("v1=")) return false;
    const given = part.slice(3);
    if (given.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  });
}

export interface SubscriptionUpdate {
  projectId: string;
  customerId: string | null;
  subscriptionId: string | null;
  status: string;
  plan: "free" | "guardian";
}

function asId(value: unknown): string | null {
  if (typeof value === "string" && value) return value;
  if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") {
    return (value as { id: string }).id;
  }
  return null;
}

function projectIdOf(object: Record<string, unknown>): string | null {
  const metadata = object.metadata;
  const id = metadata && typeof metadata === "object" ? (metadata as { projectId?: unknown }).projectId : undefined;
  return typeof id === "string" && PROJECT_ID.test(id) ? id : null;
}

/** Maps a Stripe event onto one app. Unrelated events and unpaid checkouts change nothing. */
export function subscriptionFromEvent(event: unknown): SubscriptionUpdate | null {
  if (!event || typeof event !== "object") return null;
  const type = (event as { type?: unknown }).type;
  const object = (event as { data?: { object?: unknown } }).data?.object;
  if (typeof type !== "string" || !object || typeof object !== "object") return null;
  const row = object as Record<string, unknown>;
  const projectId = projectIdOf(row);
  if (!projectId) return null;
  if (type === "checkout.session.completed") {
    const paid = row.payment_status === "paid" || row.payment_status === "no_payment_required";
    if (row.mode !== "subscription" || !paid) return null;
    return {
      projectId,
      customerId: asId(row.customer),
      subscriptionId: asId(row.subscription),
      status: "active",
      plan: "guardian",
    };
  }
  if (type === "customer.subscription.updated" || type === "customer.subscription.deleted") {
    const status = type === "customer.subscription.deleted" ? "canceled" : asId(row.status) ?? String(row.status ?? "");
    if (!status) return null;
    const entitled = status === "active" || status === "trialing";
    return {
      projectId,
      customerId: asId(row.customer),
      subscriptionId: asId(row.id),
      status,
      plan: entitled ? "guardian" : "free",
    };
  }
  return null;
}

export function checkoutForm(input: {
  priceId: string;
  projectId: string;
  successUrl: string;
  cancelUrl: string;
}): URLSearchParams {
  const body = new URLSearchParams();
  body.set("mode", "subscription");
  body.set("line_items[0][price]", input.priceId);
  body.set("line_items[0][quantity]", "1");
  body.set("success_url", input.successUrl);
  body.set("cancel_url", input.cancelUrl);
  body.set("client_reference_id", input.projectId);
  body.set("metadata[projectId]", input.projectId);
  body.set("subscription_data[metadata][projectId]", input.projectId);
  return body;
}
