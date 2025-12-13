import type { NextApiRequest, NextApiResponse } from "next"
import Stripe from "stripe"
import { createClient } from "@supabase/supabase-js"

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2024-06-20" })

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

function priceIdForPlan(plan: "pro" | "business") {
  if (plan === "pro") return process.env.NEXT_PUBLIC_STRIPE_GROWTH_PRICE_ID
  return process.env.NEXT_PUBLIC_STRIPE_BUSINESS_PRICE_ID
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" })

  try {
    const { userId, email, plan, successUrl, cancelUrl } = req.body as {
      userId: string
      email: string
      plan: "pro" | "business"
      successUrl: string
      cancelUrl: string
    }

    const priceId = priceIdForPlan(plan)
    if (!userId || !email || !plan || !priceId || !successUrl || !cancelUrl) {
      return res.status(400).json({ error: "Missing required fields" })
    }

    // Find/create customer
    const { data: existing } = await supabaseAdmin
      .from("stripe_customers")
      .select("stripe_customer_id")
      .eq("user_id", userId)
      .maybeSingle()

    let customerId = existing?.stripe_customer_id

    if (!customerId) {
      const customer = await stripe.customers.create({ email, metadata: { userId } })
      customerId = customer.id
      await supabaseAdmin.from("stripe_customers").upsert({
        user_id: userId,
        stripe_customer_id: customerId,
      })
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: true,
      metadata: { userId, plan },
    })

    return res.status(200).json({ url: session.url })
  } catch (err: any) {
    console.error(err)
    return res.status(500).json({ error: err?.message ?? "Server error" })
  }
}
