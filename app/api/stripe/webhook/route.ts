import Stripe from "stripe";
import { headers } from "next/headers";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function toIsoFromUnixSeconds(sec: number | null | undefined) {
  if (!sec) return null;
  return new Date(sec * 1000).toISOString();
}

export async function POST(req: Request) {
  const sig = headers().get("stripe-signature");
  const body = await req.text();

  if (!sig) return new Response("Missing stripe-signature", { status: 400 });

  const secrets = [
    process.env.STRIPE_WEBHOOK_SECRET, // Dashboard endpoint secret (Vercel endpoint)
    process.env.STRIPE_CLI_WEBHOOK_SECRET, // Stripe CLI listen secret
  ].filter(Boolean) as string[];

  let event: Stripe.Event | null = null;
  let lastErr: any = null;

  for (const secret of secrets) {
    try {
      event = stripe.webhooks.constructEvent(body, sig, secret);
      break; // ✅ verified
    } catch (err) {
      lastErr = err;
    }
  }

  if (!event) {
    console.error("❌ Webhook signature verification failed:", lastErr?.message);
    return new Response(
      `Webhook Error: ${lastErr?.message ?? "Invalid signature"}`,
      { status: 400 }
    );
  }

  console.log("✅ Stripe event verified:", event.type);

  switch (event.type) {
    /**
     * Fired after checkout completes. Session has subscription id + email.
     * We then fetch the Subscription to get current_period_end.
     */
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
console.log(
  "🔍 FULL CHECKOUT SESSION PAYLOAD:",
  JSON.stringify(session, null, 2)
);

      const email =
        session.customer_details?.email ?? session.customer_email ?? null;

      if (!email) {
        console.error("❌ No email on checkout session", { sessionId: session.id });
        break;
      }

      const subscriptionId =
        typeof session.subscription === "string" ? session.subscription : null;

      const customerId =
        typeof session.customer === "string" ? session.customer : null;

      // Pull plan from metadata (your create-checkout-session now sets metadata.plan)
      const plan = session.metadata?.plan ?? "unknown";

      // Fetch subscription to store current_period_end
      let currentPeriodEndIso: string | null = null;
      let status: string = "active";

      if (subscriptionId) {
        try {
          const sub = await stripe.subscriptions.retrieve(subscriptionId);
          currentPeriodEndIso = toIsoFromUnixSeconds(sub.current_period_end);
          status = sub.status ?? "active";
        } catch (e: any) {
          console.error("⚠️ Could not retrieve subscription:", e?.message || e);
        }
      }

      const { error } = await supabase
        .from("subscriptions")
        .upsert(
          {
            email,
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
            plan,
            status,
            current_period_end: currentPeriodEndIso,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "email" }
        );

      if (error) {
        console.error("❌ Supabase upsert failed:", error);
      } else {
        console.log("✅ Wrote subscription row for:", email);
      }

      break;
    }

    /**
     * Keep subscription status + period end in sync on renewals, upgrades, etc.
     */
    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;

      const { error } = await supabase
        .from("subscriptions")
        .update({
          status: sub.status ?? "active",
          current_period_end: toIsoFromUnixSeconds(sub.current_period_end),
          updated_at: new Date().toISOString(),
        })
        .eq("stripe_subscription_id", sub.id);

      if (error) console.error("❌ Supabase update failed:", error);

      break;
    }

    /**
     * When Stripe deletes the subscription, mark canceled.
     */
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;

      const { error } = await supabase
        .from("subscriptions")
        .update({
          status: "canceled",
          current_period_end: toIsoFromUnixSeconds(sub.current_period_end),
          updated_at: new Date().toISOString(),
        })
        .eq("stripe_subscription_id", sub.id);

      if (error) console.error("❌ Supabase update failed:", error);

      break;
    }

    /**
     * Optional but useful: if payment fails, mark past_due/unpaid
     */
    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;

      const subscriptionId =
        typeof invoice.subscription === "string" ? invoice.subscription : null;

      if (subscriptionId) {
        const { error } = await supabase
          .from("subscriptions")
          .update({
            status: "past_due",
            updated_at: new Date().toISOString(),
          })
          .eq("stripe_subscription_id", subscriptionId);

        if (error) console.error("❌ Supabase update failed:", error);
      }

      break;
    }

    default: {
      console.log("Ignoring event:", event.type);
    }
  }

  return new Response("ok", { status: 200 });
}

export async function GET() {
  return new Response("Method Not Allowed", { status: 405 });
}

