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

export async function POST(req: Request) {
  const origin = req.headers.get("origin");

  try {
    const key = process.env.STRIPE_SECRET_KEY;

    if (!key) {
      return Response.json(
        { error: "Missing STRIPE_SECRET_KEY" },
        { status: 500, headers: corsHeaders(origin) }
      );
    }

    // Helpful sanity check: tells you if you're using test or live key
    const keyMode = key.startsWith("sk_test_")
      ? "test"
      : key.startsWith("sk_live_")
      ? "live"
      : "unknown";

    const body = await req.json().catch(() => null);

    const planRaw = (body?.plan ?? "").toString().toLowerCase();
    const plan = planRaw as "pro" | "business";

    const successUrl = body?.successUrl ? String(body.successUrl) : undefined;
    const cancelUrl = body?.cancelUrl ? String(body.cancelUrl) : undefined;

    // Optional (email-first now, userId later)
    const userId = body?.userId ? String(body.userId) : undefined;
    const email = body?.email ? String(body.email) : undefined;

    if (!plan || !["pro", "business"].includes(plan)) {
      return Response.json(
        { error: "plan must be 'pro' or 'business'" },
        { status: 400, headers: corsHeaders(origin) }
      );
    }

    if (!successUrl || !cancelUrl) {
      return Response.json(
        { error: "Missing successUrl or cancelUrl" },
        { status: 400, headers: corsHeaders(origin) }
      );
    }

    const proPrice = process.env.NEXT_PUBLIC_STRIPE_GROWTH_PRICE_ID;
    const businessPrice = process.env.NEXT_PUBLIC_STRIPE_BUSINESS_PRICE_ID;

    const price = plan === "pro" ? proPrice : businessPrice;

    if (!price) {
      return Response.json(
        {
          error: "Missing Stripe price ID env vars",
          detail:
            "Set NEXT_PUBLIC_STRIPE_GROWTH_PRICE_ID and NEXT_PUBLIC_STRIPE_BUSINESS_PRICE_ID in Vercel.",
        },
        { status: 500, headers: corsHeaders(origin) }
      );
    }

    // Tripwire: MUST be a Stripe Price ID, not a Product ID
    if (!price.startsWith("price_")) {
      return Response.json(
        {
          error: "Invalid price ID configured",
          detail: `Expected a Stripe Price ID starting with "price_" but got: ${price}`,
          hint:
            "In Vercel env vars, NEXT_PUBLIC_STRIPE_*_PRICE_ID must be price_..., not prod_...",
        },
        { status: 500, headers: corsHeaders(origin) }
      );
    }

    // Optional verification (super useful for debugging):
    // If the price doesn't exist in THIS Stripe account/mode, this will throw.
    const retrievedPrice = await stripe.prices.retrieve(price);

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: retrievedPrice.id, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,

      customer_email: email || undefined,
      client_reference_id: userId || undefined,

      metadata: {
        plan: String(plan),
        ...(email ? { email } : {}),
        ...(userId ? { userId } : {}),
        keyMode, // "test" or "live" (handy to see in webhook metadata)
      },
    });

    return Response.json(
      {
        url: session.url,
        debug: { keyMode, priceUsed: retrievedPrice.id },
      },
      { status: 200, headers: corsHeaders(origin) }
    );
  } catch (err: any) {
    return Response.json(
      { error: "Server error", detail: err?.message || String(err) },
      { status: 500, headers: corsHeaders(origin) }
    );
  }
}


