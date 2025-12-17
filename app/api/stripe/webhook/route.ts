import Stripe from "stripe"
import { headers } from "next/headers"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2023-10-16",
})

function mustEnv(name: string) {
  const v = process.env[name]
  if (!v) throw new Error(`Missing env var: ${name}`)
  return v
}

async function supabaseRequest(pathAndQuery: string, method: string, body?: any) {
  const SUPABASE_URL = mustEnv("SUPABASE_URL")
  const SERVICE_ROLE = mustEnv("SUPABASE_SERVICE_ROLE_KEY")

  const url = `${SUPABASE_URL}/rest/v1/${pathAndQuery}`

  const res = await fetch(url, {
    method,
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Supabase request failed: ${res.status} ${text}`)
  }

  return res.json().catch(() => null)
}

async function upsertSubscription(row: {
  email: string
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  plan: string
  status: string
  updated_at: string
}) {
  // upsert by email
  return supabaseRequest(`subscriptions?on_conflict=email`, "POST", row)
}

async function updateProfilePlanByUserId(userId: string, plan: string) {
  // PATCH where id = userId
  await supabaseRequest(`profiles?id=eq.${encodeURIComponent(userId)}`, "PATCH", {
    plan,
  })
}

async function updateProfilePlanByEmail(email: string, plan: string) {
  // PATCH where email = email
  await supabaseRequest(`profiles?email=eq.${encodeURIComponent(email)}`, "PATCH", {
    plan,
  })
}

export async function POST(req: Request) {
  const sig = headers().get("stripe-signature")
  const body = await req.text()

  if (!sig) return new Response("Missing stripe-signature", { status: 400 })

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
  if (!webhookSecret) {
    console.error("❌ Missing STRIPE_WEBHOOK_SECRET")
    return new Response("Missing STRIPE_WEBHOOK_SECRET", { status: 500 })
  }

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret)
  } catch (err: any) {
    console.error("❌ Webhook signature verification failed:", err?.message || err)
    return new Response(`Webhook Error: ${err?.message ?? "Invalid signature"}`, {
      status: 400,
    })
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session

      const email =
        session.customer_details?.email ??
        session.customer_email ??
        session.metadata?.email ??
        null

      const userId =
        (typeof session.client_reference_id === "string" && session.client_reference_id) ||
        session.metadata?.userId ||
        null

      const plan = (session.metadata?.plan || "unknown").toLowerCase()

      const subscriptionId =
        typeof session.subscription === "string" ? session.subscription : null

      const customerId =
        typeof session.customer === "string" ? session.customer : null

      if (!email) {
        console.error("❌ No email on checkout session", { sessionId: session.id })
        return new Response("ok", { status: 200 })
      }

      // 1) write subscriptions table (your existing billing table)
      await upsertSubscription({
        email,
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        plan,
        status: "active",
        updated_at: new Date().toISOString(),
      })

      // 2) ✅ update profiles.plan so dashboard unlocks
      // Prefer userId (most reliable). Fallback to email.
      if (userId) {
        await updateProfilePlanByUserId(userId, plan)
      } else {
        await updateProfilePlanByEmail(email, plan)
      }

      console.log("✅ checkout.session.completed -> updated subscription + profile", {
        email,
        userId,
        plan,
      })
    }

    // Optional: if you later support upgrades via portal, also handle subscription updates here.
    // if (event.type === "customer.subscription.updated") { ... }

  } catch (e: any) {
    console.error("❌ Webhook handler error:", e?.message || e)
    // Return 200 to avoid endless retries while iterating
  }

  return new Response("ok", { status: 200 })
}

export async function GET() {
  return new Response("Method Not Allowed", { status: 405 })
}



