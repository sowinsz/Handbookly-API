import Stripe from "stripe";

export const runtime = "nodejs";

// Use the same Stripe API version as the rest of your project.
// (Your webhook route is currently not relying on apiVersion typing, so this is fine.)
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
    if (!process.env.STRIPE_SECRET_KEY) {
      return Response.json(
        { error: "Missing STRIPE_SECRET_KEY" },
        { status: 500, headers: corsHeaders(origin) }
      );
    }

    const body = await req.json().catch(() => null);

    const planRaw = (body?.plan ?? "").toString().toLowerCase();
    const plan = planRaw as "pro" | "business";

    const successUrl = body?.successUrl as string | undefined;
    const cancelUrl = body?.cancelUrl as string | undefined;

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

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,

      // Email-first (good now)
      customer_email: email || undefined,

      // Upgrade path to userId later (good to keep)
      client_reference_id: userId || undefined,

      // Make webhook/DB logic reliable
      metadata: {
        plan: String(plan),
        ...(email ? { email } : {}),
        ...(userId ? { userId } : {}),
      },
    });

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

