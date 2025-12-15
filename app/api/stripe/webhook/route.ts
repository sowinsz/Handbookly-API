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

export async function POST(req: Request) {
  const sig = headers().get("stripe-signature");
  const body = await req.text();

  if (!sig) return new Response("Missing stripe-signature", { status: 400 });

  const secrets = [
    process.env.STRIPE_WEBHOOK_SECRET, // Dashboard endpoint secret
    process.env.STRIPE_CLI_WEBHOOK_SECRET, // CLI listen secret
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
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;

      const email =
        session.customer_details?.email ??
        session.customer_email;

      if (!email) {
        console.error("❌ No email on checkout session", { sessionId: session.id });
        break;
      }

      const subscriptionId =
        typeof session.subscription === "string" ? session.subscription : null;

      const customerId =
        typeof session.customer === "string" ? session.customer : null;

      const { error } = await supabase
        .from("subscriptions")
        .upsert(
          {
            email,
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
            plan: session.metadata?.plan ?? "unknown",
            status: "active",
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

    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;

      await supabase
        .from("subscriptions")
        .update({
          status: "canceled",
          updated_at: new Date().toISOString(),
        })
        .eq("stripe_subscription_id", subscription.id);

      break;
    }

    case "invoice.paid": {
      // Optional: useful later. Leaving as no-op for now.
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

