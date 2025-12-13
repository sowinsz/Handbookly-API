import Stripe from "stripe"

export const runtime = "nodejs"

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2023-10-16",
})

export async function POST(req: Request) {
  console.log("HIT app route create-checkout-session")

  if (!process.env.STRIPE_SECRET_KEY) {
    return Response.json({ error: "Missing STRIPE_SECRET_KEY" }, { status: 500 })
  }

  const body = await req.json().catch(() => null)

  return Response.json(
    { ok: true, received: body, note: "Route is working. Next step: create real Checkout Session." },
    { status: 200 }
  )
}

export async function GET() {
  return Response.json({ error: "Method Not Allowed" }, { status: 405 })
}
