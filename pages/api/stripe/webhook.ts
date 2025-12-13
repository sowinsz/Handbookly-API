import type { NextApiRequest, NextApiResponse } from "next"
import Stripe from "stripe"
import { buffer } from "micro"
import { createClient } from "@supabase/supabase-js"

export const config = {
  api: { bodyParser: false },
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2023-10-16",
})

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

function planFromPriceId(priceId: string): "pro" | "business" | "free" {
  if (priceId === process.env.NEXT_PUBLIC_STRIPE_GROWTH_PRICE_ID) return "pro"
  if (priceId === process.env.NEXT_PUBLIC_STRIPE_BUSINESS_PRICE_ID) return "business"
  return "free"
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const sig = req.headers["stripe-signature"]
  if (!sig) return res.status(400).send("Missing stripe-signature")

  let event: Stripe.Event

  try {
    const buf = await buffer(req)
    event = stripe.webhooks.constructEvent(
      buf,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    )
  } catch (err: any) {
    console.error("Webhook signature verification failed.", err.message)
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }

  try {
    // Handle successful checkout and subscription changes
    if (
      event.type === "checkout.session.completed" ||
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated"
    ) {
      const obj: any = event.data.object

      // Resolve Stripe customer id
      const customerId = obj.customer as string | undefined
      if (!customerId) return res.json({ received: true })

      // Find Supabase user_id from our mapping table
      const { data: mapping, error: mapErr } = await supabaseAdmin
        .from("stripe_customers")
        .select("user_id")
        .eq("stripe_customer_id", customerId)
        .maybeSingle()

      if (mapErr) throw new Error(mapErr.message)
      if (!mapping?.user_id) return res.json({ received: true })

      // Resolve priceId: best source is the subscription itself
      let priceId: string | undefined

      if (event.type === "checkout.session.completed" && obj.subscription) {
        const sub = await stripe.subscriptions.retrieve(obj.subscription as string)
        priceId = sub.items.data[0]?.price?.id
      } else if (obj.items?.data?.[0]?.price?.id) {
        priceId = obj.items.data[0].price.id
      }

      if (priceId) {
        const nextPlan = planFromPriceId(priceId)

        const { error: updErr } = await supabaseAdmin
          .from("profiles")
          .update({ plan: nextPlan })
          .eq("id", mapping.user_id)

        if (updErr) throw new Error(updErr.message)
      }
    }

    // Downgrade on subscription cancel
    if (event.type === "customer.subscription.deleted") {
      const sub: any = event.data.object
      const customerId = sub.customer as string | undefined
      if (!customerId) return res.json({ received: true })

      const { data: mapping, error: mapErr } = await supabaseAdmin
        .from("stripe_customers")
        .select("user_id")
        .eq("stripe_customer_id", customerId)
        .maybeSingle()

      if (mapErr) throw new Error(mapErr.message)

      if (mapping?.user_id) {
        const { error: updErr } = await supabaseAdmin
          .from("profiles")
          .update({ plan: "free" })
          .eq("id", mapping.user_id)

        if (updErr) throw new Error(updErr.message)
      }
    }

    return res.json({ received: true })
  } catch (err: any) {
    console.error("Webhook handler failed:", err.message)
    return res.status(500).send(err.message)
  }
}

