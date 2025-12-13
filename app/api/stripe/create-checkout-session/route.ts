import Stripe from "stripe"

export const runtime = "nodejs"

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2023-10-16",
})

function corsHeaders(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  }
}

export async function OPTIONS(req: Request) {
  const origin = req.headers.get("origin")
  return new Response(null, { status: 204, headers: corsHeaders(origin) })
}

export async function POST(req: Request) {
  const origin = req.headers.get("origin")

  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      return Response.json(
        { error: "Missing STRIPE_SECRET_KEY" },
        { status: 500, headers: corsHeaders(origin) }
      )
    }

    const body = await req.json().catch(() => null)

    const plan = (body?.plan || "").toLowerCase() as "pro" | "business"
    const successUrl = body?.successUrl as string | undefined
    const cancelUrl = body?.cancelUrl as string | undefined
    const userId = body?.userId as string | undefined
    const email = body?.email as string | undefined

    if (!plan || !["pro", "business"].includes(plan)) {
      return Response.json(
        { error: "plan must be 'pro' or 'business'" },
        { status: 400, headers: corsHeaders(origin) }
      )
    }

    if (!successUrl || !cancelUrl) {
      return Response.json(
        { error: "Missing successUrl or cancelUrl" },
        { status: 400, headers: corsHeaders(origin) }
      )
    }

    const proPrice = process.env.NEXT_PUBLIC_STRIPE_GROWTH_PRICE_ID
    const businessPrice = process.env.NEXT_PUBLIC_STRIPE_BUSINESS_PRICE_ID

    const price = plan === "pro" ? proPrice : businessPrice
    if (!price) {
      return Response.json(
        { error: "Missing Stripe price ID env vars" },
        { status: 500, headers: corsHeaders(origin) }
      )
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer_email: email || undefined,
      client_reference_id: userId || undefined,
      metadata: { user_id: userId || "", target_plan: plan },
    })

    return Response.json(
      { url: session.url },
      { status: 200, headers: corsHeaders(origin) }
    )
  } catch (err: any) {
    return Response.json(
      { error: "Server error", detail: err?.message || String(err) },
      { status: 500, headers: corsHeaders(origin) }
    )
  }
}
