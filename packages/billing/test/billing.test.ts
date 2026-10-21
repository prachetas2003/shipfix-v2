import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GUARDIAN_PRICE_CENTS,
  PLAN_OFFERS,
  checkoutForm,
  guardianEntitled,
  subscriptionFromEvent,
  verifyStripeSignature,
} from "../src/index";

const PROJECT = "11111111-1111-4111-8111-111111111111";

function sign(raw: string, secret: string, timestamp: number): string {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

describe("billing plans", () => {
  it("keeps deploy free, prices Guardian at $29, and leaves Agency without checkout", () => {
    expect(GUARDIAN_PRICE_CENTS).toBe(2900);
    expect(PLAN_OFFERS.find((plan) => plan.id === "free")).toMatchObject({ priceCents: 0, checkout: false });
    expect(PLAN_OFFERS.find((plan) => plan.id === "guardian")).toMatchObject({ priceCents: 2900, checkout: true });
    expect(PLAN_OFFERS.find((plan) => plan.id === "agency")?.checkout).toBe(false);
    expect(guardianEntitled("guardian", "active")).toBe(true);
    expect(guardianEntitled("guardian", "past_due")).toBe(false);
    expect(guardianEntitled("free", "active")).toBe(false);
  });

  it("accepts a fresh Stripe signature and rejects a stale or altered one", () => {
    const raw = '{"ok":true}';
    const now = 1_700_000_000;
    expect(verifyStripeSignature(raw, sign(raw, "whsec_test", now), "whsec_test", now)).toBe(true);
    expect(verifyStripeSignature(raw, sign(raw, "whsec_test", now - 301), "whsec_test", now)).toBe(false);
    expect(verifyStripeSignature(`${raw} `, sign(raw, "whsec_test", now), "whsec_test", now)).toBe(false);
  });

  it("grants Guardian only after a paid subscription checkout", () => {
    expect(
      subscriptionFromEvent({
        type: "checkout.session.completed",
        data: {
          object: {
            mode: "subscription",
            payment_status: "paid",
            customer: "cus_1",
            subscription: "sub_1",
            metadata: { projectId: PROJECT },
          },
        },
      }),
    ).toMatchObject({ projectId: PROJECT, plan: "guardian", status: "active" });
    expect(
      subscriptionFromEvent({
        type: "checkout.session.completed",
        data: { object: { mode: "subscription", payment_status: "unpaid", metadata: { projectId: PROJECT } } },
      }),
    ).toBeNull();
  });

  it("returns the app to Free when the subscription is no longer active", () => {
    expect(
      subscriptionFromEvent({
        type: "customer.subscription.deleted",
        data: { object: { id: "sub_1", customer: "cus_1", status: "canceled", metadata: { projectId: PROJECT } } },
      }),
    ).toMatchObject({ plan: "free", status: "canceled" });
  });

  it("puts the app id on the Checkout session", () => {
    const body = checkoutForm({
      priceId: "price_123",
      projectId: PROJECT,
      successUrl: "https://app.example/ok",
      cancelUrl: "https://app.example/cancel",
    });
    expect(body.get("metadata[projectId]")).toBe(PROJECT);
    expect(body.get("line_items[0][price]")).toBe("price_123");
    expect(body.get("mode")).toBe("subscription");
  });
});
