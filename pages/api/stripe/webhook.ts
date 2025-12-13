import type { NextApiRequest, NextApiResponse } from "next"
import Stripe from "stripe"
import { buffer } from "micro"
import { createClient } from "@supabase/supabase-js"

export const config = {
  api: { bodyParser: false },
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2023-10-16",
})

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || ""
)

function planFromPrice(priceId: string | null | undefined): "pro" | "business" | null {
  if (!priceId) return null
  if (priceId === process.env.NEXT_PUBLIC_STRIPE_GROWTH_PRICE_ID) return "pro"
  if (priceId === process.env.NEXT_PUBLIC_STRIPE_BUSINESS_PRICE_ID) return "business"
  return null
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  console.log("HIT webhook", req.method)

  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed")
  }

  if (!process.env.STRIPE_SECRET_KEY) return res.status(500).send("Missing STRIPE_SECRET_KEY")
  if (!process.env.STRIPE_WEBHOOK_SECRET) return res.status(500).send("Missing STRIPE_WEBHOOK_SECRET")
  if (!process.env.SUPABASE_URL) return res.status(500).send("Missing SUPABASE_URL")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(500).send("Missing SUPABASE_SERVICE_ROLE_KEY")

  try {
    const sig = req.headers["stripe-signature"]
    if (!sig || Array.isArray(sig)) return res.status(400).send("Missing stripe-signature")

    const rawBody = await buffer(req)
    const event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    )

    console.log("Stripe event:", event.type)

    // We update plan when a subscription is created/updated/paid
    if (
      event.type === "checkout.session.completed" ||
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "invoice.paid"
    ) {
      let userId: string | null = null
      let priceId: string | null = null

      if (event.type === "checkout.session.completed") {
        const session = event.data.object as Stripe.Checkout.Session
        userId = (session.metadata?.user_id as string) || null

        // session line items aren't expanded by default, so we rely on metadata target_plan
        const targetPlan = (session.metadata?.target_plan as string) || null
        if (targetPlan === "pro" || targetPlan === "business") {
          const { error } = await supabaseAdmin
            .from("profiles")
            .update({ plan: targetPlan })
            .eq("id", userId)

          if (error) {
            console.error("profiles update error:", error)
            return res.status(500).send("Failed to update profile plan")
          }
          console.log("Updated plan via checkout.session.completed:", userId, targetPlan)
        }
      } else {
        const sub = event.data.object as Stripe.Subscription
        // try metadata on subscription
        userId = (sub.metadata?.user_id as string) || null
        priceId = sub.items?.data?.[0]?.price?.id || null
        const nextPlan = planFromPrice(priceId)

        if (userId && nextPlan) {
          const { error } = await supabaseAdmin
            .from("profiles")
            .update({ plan: nextPlan })
            .eq("id", userId)

          if (error) {
            console.error("profiles update error:", error)
            return res.status(500).send("Failed to update profile plan")
          }
          console.log("Updated plan via subscription/invoice:", userId, nextPlan)
        }
      }
    }

    return res.status(200).json({ received: true })
  } catch (err: any) {
    console.error("webhook error:", err?.message || err)
    return res.status(400).send(`Webhook Error: ${err?.message || "unknown"}`)
  }
}
