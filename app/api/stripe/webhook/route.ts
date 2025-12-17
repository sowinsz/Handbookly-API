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

async function upsertSubscription(row: {
  email: string
  user_id?: string | null
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  plan: string
  status: string
  current_period_end?: string | null
}) {
  return supabaseFetch(`subscriptions?on_conflict=email`, "POST", {
    ...row,
    updated_at: new Date().toISOString(),
  })
}

async function updateProfilePlanById(userId: string, plan: string) {
  await supabaseFetch(`profiles?id=eq.${encodeURIComponent(userId)}`, "PATCH", {
    plan,
  })
}

async function updateProfilePlanByEmail(email: string, plan: string) {
  await supabaseFetch(`profiles?email=eq.${encodeURIComponent(email)}`, "PATCH", {
    plan,
  })
}

// Helper: when unpaid/canceled, lock them
async function lockUser(userIdOrEmail: { userId?: string | null; email?: string | null }) {
  if (userIdOrEmail.userId) {
    await updateProfilePlanById(userIdOrEmail.userId, "pending")
  } else if (userIdOrEmail.email) {
    await updateProfilePlanByEmail(userIdOrEmail.email, "pending")
  }
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
    return new Response(`Webhook Error: ${err?.message ?? "Invalid signature"}`, { status: 400 })
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
          (typeof session.client_reference_id === "string" && session.client_reference_id) ||
          session.metadata?.userId ||
          null

        const plan = String(session.metadata?.plan || "unknown").toLowerCase()

        const subscriptionId =
          typeof session.subscription === "string" ? session.subscription : null

        const customerId =
          typeof session.customer === "string" ? session.customer : null

        if (!email) break

        await upsertSubscription({
          email,
          user_id: userId,
          stripe_customer_id: customerId,
          stripe_subscription_id: subscriptionId,
          plan,
          status: "active",
        })

        if (userId) await updateProfilePlanById(userId, plan)
        else await updateProfilePlanByEmail(email, plan)

        break
      }

      // ✅ Plan changes, cancellations at period end, etc.
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription

        const customerId = typeof sub.customer === "string" ? sub.customer : null
        const subscriptionId = sub.id

        // Best: use metadata stored on the subscription (set it when creating checkout)
        const plan = String((sub.metadata as any)?.plan || "unknown").toLowerCase()
        const status = sub.status

        // Find user via subscriptions table (by stripe_subscription_id)
        const rows = await supabaseFetch(
          `subscriptions?stripe_subscription_id=eq.${encodeURIComponent(subscriptionId)}&select=email,user_id`,
          "GET"
        )

        const email = rows?.[0]?.email ?? null
        const userId = rows?.[0]?.user_id ?? null

        await supabaseFetch(
          `subscriptions?stripe_subscription_id=eq.${encodeURIComponent(subscriptionId)}`,
          "PATCH",
          {
            stripe_customer_id: customerId,
            plan,
            status,
            updated_at: new Date().toISOString(),
          }
        )

        // If still active, keep plan; if not active, lock
        if (status === "active" || status === "trialing") {
          if (userId) await updateProfilePlanById(userId, plan)
          else if (email) await updateProfilePlanByEmail(email, plan)
        } else {
          await lockUser({ userId, email })
        }

        break
      }

      // ✅ Payment failed -> lock access
      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice
        const subscriptionId =
          typeof invoice.subscription === "string" ? invoice.subscription : null
        if (!subscriptionId) break

        const rows = await supabaseFetch(
          `subscriptions?stripe_subscription_id=eq.${encodeURIComponent(subscriptionId)}&select=email,user_id`,
          "GET"
        )

        const email = rows?.[0]?.email ?? null
        const userId = rows?.[0]?.user_id ?? null

        await supabaseFetch(
          `subscriptions?stripe_subscription_id=eq.${encodeURIComponent(subscriptionId)}`,
          "PATCH",
          { status: "past_due", updated_at: new Date().toISOString() }
        )

        await lockUser({ userId, email })
        break
      }

      // ✅ Subscription ended -> lock access
      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription
        const subscriptionId = subscription.id

        const rows = await supabaseFetch(
          `subscriptions?stripe_subscription_id=eq.${encodeURIComponent(subscriptionId)}&select=email,user_id`,
          "GET"
        )

        const email = rows?.[0]?.email ?? null
        const userId = rows?.[0]?.user_id ?? null

        await supabaseFetch(
          `subscriptions?stripe_subscription_id=eq.${encodeURIComponent(subscriptionId)}`,
          "PATCH",
          { status: "canceled", updated_at: new Date().toISOString() }
        )

        await lockUser({ userId, email })
        break
      }

      default:
        console.log("Ignoring event:", event.type)
    }
  } catch (e: any) {
    console.error("❌ Webhook handler error:", e?.message || e)
  }

  return new Response("ok", { status: 200 })
}

export async function GET() {
  return new Response("Method Not Allowed", { status: 405 })
}




