import Stripe from "stripe";
import { headers } from "next/headers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function supabaseUpsertSubscription(row: {
  email: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  plan: string;
  status: string;
  current_period_end?: string | null;
}) {
  const SUPABASE_URL = mustEnv("SUPABASE_URL");
  const SERVICE_ROLE = mustEnv("SUPABASE_SERVICE_ROLE_KEY");

  // Upsert by email (requires a UNIQUE constraint on email, which you likely have / want)
  const url =
    `${SUPABASE_URL}/rest/v1/subscriptions?on_conflict=email`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify(row),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase upsert failed: ${res.status} ${text}`);
  }

  return res.json().catch(() => null);
}

async function supabaseCancelBySubscriptionId(subscriptionId: string) {
  const SUPABASE_URL = mustEnv("SUPABASE_URL");
  const SERVICE_ROLE = mustEnv("SUPABASE_SERVICE_ROLE_KEY");

  const url =
    `${SUPABASE_URL}/rest/v1/subscriptions?stripe_subscription_id=eq.${encodeURIComponent(subscriptionId)}`;

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      status: "canceled",
      updated_at: new Date().toISOString(),
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase cancel update failed: ${res.status} ${text}`);
  }
}

export async function POST(req: Request) {
  const sig = headers().get("stripe-signature");
  const body = await req.text();

  if (!sig) return new Response("Missing stripe-signature", { status: 400 });

  const secrets = [
    process.env.STRIPE_WEBHOOK_SECRET,      // Stripe dashboard endpoint secret (whsec_...)
    process.env.STRIPE_CLI_WEBHOOK_SECRET,  // Stripe CLI listen secret (whsec_...)
  ].filter(Boolean) as string[];

  let event: Stripe.Event | null = null;
  let lastErr: any = null;

  for (const secret of secrets) {
    try {
      event = stripe.webhooks.constructEvent(body, sig, secret);
      break;
    } catch (err) {
      lastErr = err;
    }
  }

  if (!event) {
    console.error("❌ Webhook signature verification failed:", lastErr?.message);
    return new Response(`Webhook Error: ${lastErr?.message ?? "Invalid signature"}`, {
      status: 400,
    });
  }

  console.log("✅ Stripe event verified:", event.type);

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;

        const email =
          session.customer_details?.email ??
          session.customer_email ??
          null;

        if (!email) {
          console.error("❌ No email on checkout session", { sessionId: session.id });
          break;
        }

        const subscriptionId =
          typeof session.subscription === "string" ? session.subscription : null;

        const customerId =
          typeof session.customer === "string" ? session.customer : null;

        const plan = session.metadata?.plan ?? "unknown";

        await supabaseUpsertSubscription({
          email,
          stripe_customer_id: customerId,
          stripe_subscription_id: subscriptionId,
          plan,
          status: "active",
          updated_at: new Date().toISOString(),
        });

        console.log("✅ Wrote/updated subscription row for:", email);
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        await supabaseCancelBySubscriptionId(subscription.id);
        console.log("✅ Marked canceled for subscription:", subscription.id);
        break;
      }

      default:
        console.log("Ignoring event:", event.type);
    }
  } catch (e: any) {
    console.error("❌ Webhook handler error:", e?.message || e);
    // Still return 200 so Stripe doesn't endlessly retry while you're iterating
  }

  return new Response("ok", { status: 200 });
}

export async function GET() {
  return new Response("Method Not Allowed", { status: 405 });
}

