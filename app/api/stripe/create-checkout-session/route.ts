import Stripe from "stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Server-side Stripe client (uses your STRIPE_SECRET_KEY from Vercel env vars)
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
    // --- Required env checks ---
    if (!process.env.STRIPE_SECRET_KEY) {
      return Response.json(
        { error: "Missing STRIPE_SECRET_KEY" },
        { status: 500, headers: corsHeaders(origin) }
      );
    }

    const proPrice = process.env.NEXT_PUBLIC_STRIPE_GROWTH_PRICE_ID;
    const businessPrice = process.env.NEXT_PUBLIC_STRIPE_BUSINESS_PRICE_ID;

    if (!proPrice || !businessPrice) {
      return Response.json(
        {
          error: "Missing Stripe price env vars",
          detail:
            "Set NEXT_PUBLIC_STRIPE_GROWTH_PRICE_ID and NEXT_PUBLIC_STRIPE_BUSINESS_PRICE_ID in Vercel (Production).",
        },
        { status: 500, headers: corsHeaders(origin) }
      );
    }

    // --- Parse body ---
    const body = await req.json().catch(() => null);

    const planRaw = String(body?.plan ?? "").toLowerCase().trim();
    if (planRaw !== "pro" && planRaw !== "business") {
      return Response.json(
        { error: "plan must be 'pro' or 'business'" },
        { status: 400, headers: corsHeaders(origin) }
      );
    }

    const successUrl = body?.successUrl ? String(body.successUrl) : "";
    const cancelUrl = body?.cancelUrl ? String(body.cancelUrl) : "";
    if (!successUrl || !cancelUrl) {
      return Response.json(
        { error: "Missing successUrl or cancelUrl" },
        { status: 400, headers: corsHeaders(origin) }
      );
    }

    const email = body?.email ? String(body.email) : undefined; // email-first
    const userId = body?.userId ? String(body.userId) : undefined; // later upgrade path

    const priceId = planRaw === "pro" ? proPrice : businessPrice;

    // --- Create Checkout Session ---
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,

      // Email-first
      customer_email: email,

      // Later you can use this to correlate to your DB user
      client_reference_id: userId,

      // Helps your webhook know what was purchased
      metadata: {
        plan: planRaw,
        ...(email ? { email } : {}),
        ...(userId ? { userId } : {}),
      },
    });

    if (!session.url) {
      return Response.json(
        { error: "Stripe session created but missing session.url" },
        { status: 500, headers: corsHeaders(origin) }
      );
    }

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


