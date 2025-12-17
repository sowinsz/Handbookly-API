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

async function supabaseFetch(pathAndQuery: string, method: string, body?: any) {
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

// Upsert into public.subscriptions by email (matches your current approach)
async function upsertSubscription(row: {
  email: string
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  plan: string
  status: string
  current_period_end?: string | null
}) {
  return supabaseFetch(`subscriptions?on_conflict=email`, "POST", {
    ...row,
    updated_at: new Date().toISOString(), // ✅ subscriptions can have updated_at; ok if column exists
  })
}

// ✅ Update profiles.plan ONLY (no updated_at)
async function updateProfilePlanById(userId: string, plan: string) {
  await supabaseFetch(`profiles?id=eq.${encodeURIComponent(userId)}`, "PATCH", {
    plan,
  })
}

// Fallback if userId missing
async function updateProfilePlanByEmail(email: string, plan: string) {
  await supabaseFetch(`profiles?email=eq.${encodeURIComponent(email)}`, "PATCH", {
    plan,
  })
}

async function cancelSubscriptionById(subscriptionId: string) {
  // Mark subscription canceled (does not touch profiles here)
  await supabaseFetch(
    `subscriptions?stripe_subscription_id=eq.${encodeURIComponent(subscriptionId)}`,
    "PATCH",
    {
      status: "canceled",
      updated_at: new Date().toISOString(),
    }
  )
}

export async function POST(req: Request) {
  const sig = headers().get("stripe-signature")
  const body = await req.text()

  if (!sig) return new Response("Missing stripe-signature", { status: 400 })

  const webhookSecret = mustEnv("STRIPE_WEBHOOK_SECRET")

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret)
  } catch (err: any) {
    console.error("❌ Webhook signature verification failed:", err?.message || err)
    return new Response(`Webhook Error: ${err?.message ?? "Invalid signature"}`, {
      status: 400,
    })
  }

  console.log("✅ Stripe event verified:", event.type)

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session

        const email =
          session.customer_details?.email ??
          session.customer_email ??
          session.metadata?.email ??
          null

        const userId =
          (typeof session.client_reference_id === "string" &&
            session.client_reference_id) ||
          session.metadata?.userId ||
          null

        const plan = String(session.metadata?.plan || "unknown").toLowerCase()

        const subscriptionId =
          typeof session.subscription === "string" ? session.subscription : null

        const customerId =
          typeof session.customer === "string" ? session.customer : null

        if (!email) {
          console.error("❌ No email on checkout session", { sessionId: session.id })
          break
        }

        // 1) Write/merge subscriptions row
        await upsertSubscription({
          email,
          stripe_customer_id: customerId,
          stripe_subscription_id: subscriptionId,
          plan,
          status: "active",
        })

        console.log("✅ Wrote/updated subscription row for:", email)

        // 2) ✅ Unlock dashboard by updating profiles.plan (NO updated_at)
        if (userId) {
          await updateProfilePlanById(userId, plan)
          console.log("✅ Updated profiles.plan by id:", userId, plan)
        } else {
          await updateProfilePlanByEmail(email, plan)
          console.log("✅ Updated profiles.plan by email:", email, plan)
        }

        break
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription
        await cancelSubscriptionById(subscription.id)
        console.log("✅ Marked canceled for subscription:", subscription.id)
        break
      }

      default:
        console.log("Ignoring event:", event.type)
    }
  } catch (e: any) {
    console.error("❌ Webhook handler error:", e?.message || e)
    // Return 200 so Stripe doesn't keep retrying while you're iterating
  }

  return new Response("ok", { status: 200 })
}

export async function GET() {
  return new Response("Method Not Allowed", { status: 405 })
}



