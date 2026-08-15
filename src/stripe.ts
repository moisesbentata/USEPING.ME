import Stripe from "stripe";
import { prisma } from "./db";
import { Router } from "express";

if (!process.env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY required");
if (!process.env.STRIPE_WEBHOOK_SECRET) throw new Error("STRIPE_WEBHOOK_SECRET required");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export const stripeRouter = Router();

// POST /stripe/checkout — creates a Stripe Checkout Session
// Query params: price (price_xxx), phone (user's whatsapp number)
// Optional query: fbclid, utm_source, utm_medium, utm_campaign, utm_content
stripeRouter.post("/checkout", async (req, res) => {
  const { price, phone, fbclid, utm_source, utm_medium, utm_campaign, utm_content } = req.body;

  if (!price || !phone) {
    res.status(400).json({ error: "price and phone are required" });
    return;
  }

  const metadata: Record<string, string> = { phone };
  if (fbclid) metadata.fbclid = fbclid;
  if (utm_source) metadata.utm_source = utm_source;
  if (utm_medium) metadata.utm_medium = utm_medium;
  if (utm_campaign) metadata.utm_campaign = utm_campaign;
  if (utm_content) metadata.utm_content = utm_content;

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    payment_method_types: ["card"],
    line_items: [{ price, quantity: 1 }],
    metadata,
    subscription_data: { metadata },
    success_url: `${process.env.SUCCESS_URL ?? "https://useping.me/success"}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: process.env.CANCEL_URL ?? "https://useping.me",
  });

  res.json({ url: session.url });
});

// POST /stripe/webhook — Stripe sends events here
stripeRouter.post(
  "/webhook",
  async (req, res) => {
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"] as string,
        process.env.STRIPE_WEBHOOK_SECRET!
      );
    } catch {
      res.status(400).send("Webhook signature verification failed");
      return;
    }

    if (
      event.type === "checkout.session.completed" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      await handleSubscriptionEvent(event);
    }

    res.json({ received: true });
  }
);

async function handleSubscriptionEvent(event: Stripe.Event) {
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const phone = session.metadata?.phone;
    if (!phone || !session.subscription || !session.customer) return;

    await prisma.user.upsert({
      where: { phone },
      update: {
        stripeCustomerId: session.customer as string,
        stripeSubscriptionId: session.subscription as string,
        subscriptionStatus: "active",
      },
      create: {
        phone,
        stripeCustomerId: session.customer as string,
        stripeSubscriptionId: session.subscription as string,
        subscriptionStatus: "active",
      },
    });

    await sendConversionEvent(session);
    return;
  }

  const subscription = event.data.object as Stripe.Subscription;
  const customerId = subscription.customer as string;

  await prisma.user.updateMany({
    where: { stripeCustomerId: customerId },
    data: {
      subscriptionStatus: subscription.status,
      stripeSubscriptionId: subscription.id,
    },
  });
}

async function sendConversionEvent(session: Stripe.Checkout.Session) {
  const pixelId = process.env.META_PIXEL_ID;
  const accessToken = process.env.META_CAPI_TOKEN;
  if (!pixelId || !accessToken) return;

  const phone = session.metadata?.phone;
  const fbclid = session.metadata?.fbclid;

  const eventData: Record<string, any> = {
    event_name: "Purchase",
    event_time: Math.floor(Date.now() / 1000),
    action_source: "website",
    user_data: {},
    custom_data: {
      currency: "GBP",
      value: (session.amount_total ?? 0) / 100,
    },
  };

  if (phone) eventData.user_data.ph = [phone.replace("+", "")];
  if (fbclid) eventData.user_data.fbc = `fb.1.${Date.now()}.${fbclid}`;

  const utmSource = session.metadata?.utm_source;
  if (utmSource) eventData.custom_data.utm_source = utmSource;

  await fetch(`https://graph.facebook.com/v21.0/${pixelId}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      data: [eventData],
      access_token: accessToken,
    }),
  });
}
