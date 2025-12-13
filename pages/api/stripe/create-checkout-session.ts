import type { NextApiRequest, NextApiResponse } from "next"
import Stripe from "stripe"
import { createClient } from "@supabase/supabase-js"

type Plan = "pro" | "business"

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2023-10-16",
})

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || ""
)

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  console.log("HIT create-checkout-session", req.method)

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" })
  }

  // Basic env checks with clear error messages
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: "Missing STRIPE_SECRET_KEY" })
  }
  if (!process.env.SUPABASE_URL) {
    return res.status(500).json({ error: "Missing SUPABASE_URL" })
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "Missing SUPABASE_SERVICE_ROLE_KEY" })
  }
  if (!process.env.NEXT_PUBLIC_STRIPE_GROWTH_PRICE_ID) {
    return res.status(500).json({ error: "Missing NEXT_PUBLIC_STRIPE_GROWTH_PRICE_ID" })
  }
  if (!process.env.NEXT_PUBLIC_STRIPE_BUSINESS_PRICE_ID) {
    return res.status(500).json({ error: "Missing NEXT_PUBLIC_STRIPE_BUSINESS_PRICE_ID" })
  }

  try {
    const { userId, email, plan, successUrl, cancelUrl } = (req.body || {}) as {
      userId?: string
      email?: string
      plan?: Plan
      successUrl?: string
      cancelUrl?: string
    }

    if (!userId || !email || !plan || !successUrl || !cancelUrl) {
      return res.status(400).json({
        error: "Missing required fields",
        required: ["userId", "email", "plan", "successUrl", "cancelUrl"],
        received: { userId: !!userId, email: !!email, plan: !!plan, successUrl: !!successUrl, cancelUrl: !!cancelUrl },
      })
    }

    if (plan !== "pro" && plan !== "business") {
      return res.status(400).json({ error: "Invalid plan (must be pro or business)" })
    }

    const priceId =
      plan === "pro"
        ? process.env.NEXT_PUBLIC_STRIPE_GROWTH_PRICE_ID
        : process.env.NEXT_PUBLIC_STRIPE_BUSINESS_PRICE_ID

    // 1) Find or create Stripe customer, store in Supabase
    const { data: existing, error: existingErr } = await supabaseAdmin
      .from("stripe_customers")
      .select("stripe_customer_id")
      .eq("user_id", userId)
      .maybeSingle()

    if (existingErr) {
      console.error("stripe_customers select error:", existingErr)
      return res.status(500).json({ error: "Failed to read stripe_customers" })
    }

    let stripeCustomerId = existing?.stripe_customer_id as string | null

    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email,
        metadata: { user_id: userId },
      })

      stripeCustomerId = customer.id

      const { error: upsertErr } = await supabaseAdmin
        .from("stripe_customers")
        .upsert({ user_id: userId, stripe_customer_id: stripeCustomerId }, { onConflict: "user_id" })

      if (upsertErr) {
        console.error("stripe_customers upsert error:", upsertErr)
        return res.status(500).json({ error: "Failed to write stripe_customers" })
      }
    }

    // 2) Create Checkout Session (Subscription)
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: stripeCustomerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: true,
      metadata: {
        user_id: userId,
        target_plan: plan,
      },
    })

    console.log("Checkout session created:", session.id)

    return res.status(200).json({ url: session.url })
  } catch (err: any) {
    console.error("create-checkout-session fatal:", err?.message || err)
    return res.status(500).json({ error: "Server error", detail: err?.message || String(err) })
  }
}
