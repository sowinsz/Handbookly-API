import Stripe from "stripe";

export const runtime = "nodejs";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2023-10-16",
});

function corsHeaders(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

export async function OPTIONS(req: Request) {
  const origin = req.headers.get("origin");
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

type Plan = "starter" | "growth" | "business";

export async function POST(req: Request) {
  const origin = req.headers.get("origin");

  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      return Response.json(
        { error: "Missing STRIPE_SECRET_KEY" },
        { status: 500, headers: corsHeaders(origin) }
      );
    }

    const body = await req.json().catch(() => null);

    const planRaw = (body?.plan ?? "").toString().toLowerCase();
    const plan = planRaw as Plan;

    const successUrl = body?.successUrl ? String(body.successUrl) : undefined;
    const cancelUrl = body?.cancelUrl ? String(body.cancelUrl) : undefined;

    const userId = body?.userId ? String(body.userId) : undefined;
    const email = body?.email ? String(body.email) : undefined;

    // ✅ IMPORTANT: these must match what Framer sends!
    const allowedPlans: Plan[] = ["starter", "growth", "business"];
    if (!allowedPlans.includes(plan)) {
      return Response.json(
        { error: `plan must be one of: ${allowedPlans.join(", ")}` },
        { status: 400, headers: corsHeaders(origin) }
      );
    }

    if (!successUrl || !cancelUrl) {
      return Response.json(
        { error: "Missing successUrl or cancelUrl" },
        { status: 400, headers: corsHeaders(origin) }
      );
    }

    // Map plan -> price id (set these in Vercel env vars)
    const starterPrice = process.env.NEXT_PUBLIC_STRIPE_STARTER_PRICE_ID;
    const growthPrice = process.env.NEXT_PUBLIC_STRIPE_GROWTH_PRICE_ID;
    const businessPrice = process.env.NEXT_PUBLIC_STRIPE_BUSINESS_PRICE_ID;

    const price =
      plan === "starter" ? starterPrice : plan === "growth" ? growthPrice : businessPrice;

    if (!price) {
      return Response.json(
        {
          error: "Missing Stripe price ID env var for selected plan",
          detail:
            "Set NEXT_PUBLIC_STRIPE_STARTER_PRICE_ID / NEXT_PUBLIC_STRIPE_GROWTH_PRICE_ID / NEXT_PUBLIC_STRIPE_BUSINESS_PRICE_ID in Vercel (Production).",
        },
        { status: 500, headers: corsHeaders(origin) }
      );
    }

    const session = await stripe.checkout.sessions.create({
  mode: "subscription",
  line_items: [{ price, quantity: 1 }],
  success_url: successUrl,
  cancel_url: cancelUrl,

  customer_email: email || undefined,
  client_reference_id: userId || undefined,

  // ✅ Session metadata (used by checkout.session.completed)
  metadata: {
    plan,
    ...(email ? { email } : {}),
    ...(userId ? { userId } : {}),
  },

  // ✅ Subscription metadata (used by customer.subscription.updated)
  subscription_data: {
    metadata: {
      plan,
      ...(email ? { email } : {}),
      ...(userId ? { userId } : {}),
    },
  },
})


    return Response.json(
      { url: session.url },
      { status: 200, headers: corsHeaders(origin) }
    );
  } catch (err: any) {
    return Response.json(
      { error: "Server error", detail: err?.message || String(err) },
      { status: 500, headers: corsHeaders(origin) }
    );
  }
}


