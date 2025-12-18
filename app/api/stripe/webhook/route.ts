import Stripe from "stripe"
import { headers } from "next/headers"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
    apiVersion: "2023-10-16",
})

type PaidPlan = "starter" | "growth" | "business"
type Plan = "pending" | PaidPlan

const PAID_PLANS: PaidPlan[] = ["starter", "growth", "business"]

function mustEnv(name: string) {
    const v = process.env[name]
    if (!v) throw new Error(`Missing env var: ${name}`)
    return v
}

function normalizePlan(raw: any): Plan {
    const p = String(raw || "").toLowerCase().trim()
    if (PAID_PLANS.includes(p as PaidPlan)) return p as PaidPlan
    return "pending"
}

function isPaidStatus(status: Stripe.Subscription.Status) {
    return status === "active" || status === "trialing"
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

/**
 * subscriptions table:
 * - recommended unique constraints:
 *   - stripe_subscription_id (unique) OR email (unique), ideally both.
 *
 * If you currently use `on_conflict=email`, we keep that for compatibility.
 * But we ALSO patch by stripe_subscription_id when available (more reliable).
 */
async function upsertSubscriptionByEmail(row: {
    email: string
    user_id?: string | null
    stripe_customer_id: string | null
    stripe_subscription_id: string | null
    plan: Plan
    status: string
    current_period_end?: string | null
}) {
    return supabaseFetch(`subscriptions?on_conflict=email`, "POST", {
        ...row,
        updated_at: new Date().toISOString(),
    })
}

async function patchSubscriptionBySubId(subscriptionId: string, patch: any) {
    return supabaseFetch(
        `subscriptions?stripe_subscription_id=eq.${encodeURIComponent(subscriptionId)}`,
        "PATCH",
        { ...patch, updated_at: new Date().toISOString() }
    )
}

async function findSubscriptionRowBySubId(subscriptionId: string) {
    const rows = await supabaseFetch(
        `subscriptions?stripe_subscription_id=eq.${encodeURIComponent(
            subscriptionId
        )}&select=email,user_id`,
        "GET"
    )
    return { email: rows?.[0]?.email ?? null, userId: rows?.[0]?.user_id ?? null }
}

async function updateProfilePlanById(userId: string, plan: Plan) {
    await supabaseFetch(`profiles?id=eq.${encodeURIComponent(userId)}`, "PATCH", {
        plan,
    })
}

async function updateProfilePlanByEmail(email: string, plan: Plan) {
    await supabaseFetch(
        `profiles?email=eq.${encodeURIComponent(email)}`,
        "PATCH",
        { plan }
    )
}

async function setUserPlan(userId: string | null, email: string | null, plan: Plan) {
    if (userId) return updateProfilePlanById(userId, plan)
    if (email) return updateProfilePlanByEmail(email, plan)
}

/**
 * Optional: record processed Stripe event IDs to prevent duplicate work.
 * If you DON'T have this table, this safely no-ops.
 *
 * Table:
 *   stripe_events(id text primary key, processed_at timestamptz default now())
 */
async function alreadyProcessed(eventId: string) {
    try {
        const rows = await supabaseFetch(
            `stripe_events?id=eq.${encodeURIComponent(eventId)}&select=id`,
            "GET"
        )
        return Array.isArray(rows) && rows.length > 0
    } catch {
        return false
    }
}
async function markProcessed(eventId: string) {
    try {
        await supabaseFetch(`stripe_events`, "POST", [{ id: eventId }])
    } catch {
        // ignore if table doesn't exist
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
        return new Response(`Webhook Error: ${err?.message ?? "Invalid signature"}`, {
            status: 400,
        })
    }

    // ✅ Best practice: Stripe retries; dedupe by event.id
    if (await alreadyProcessed(event.id)) {
        return new Response("ok", { status: 200 })
    }

    console.log("✅ Stripe event verified:", event.type)

    try {
        switch (event.type) {
            /**
             * Fired after Checkout completes. Good for initial “active” mapping,
             * but subscription status can change later, so we also handle subscription.* and invoice.*
             */
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

                const subscriptionId =
                    typeof session.subscription === "string" ? session.subscription : null

                const customerId =
                    typeof session.customer === "string" ? session.customer : null

                // Prefer plan from subscription metadata (if present later), but session metadata is fine here.
                const plan = normalizePlan(session.metadata?.plan)

                if (!email && !userId) break

                // Upsert by email (compat), store subscriptionId if we have it
                await upsertSubscriptionByEmail({
                    email: email || `${userId}@unknown.local`,
                    user_id: userId,
                    stripe_customer_id: customerId,
                    stripe_subscription_id: subscriptionId,
                    plan,
                    status: "active",
                })

                // If webhook fires before your subscription.updated, unlock immediately.
                if (plan !== "pending") {
                    await setUserPlan(userId, email, plan)
                }

                break
            }

            /**
             * Covers: plan changes, cancel_at_period_end toggles, renewals, status flips.
             * Use subscription.metadata.plan (you set it in create-checkout-session).
             */
            case "customer.subscription.updated": {
                const sub = event.data.object as Stripe.Subscription

                const subscriptionId = sub.id
                const customerId = typeof sub.customer === "string" ? sub.customer : null

                const plan = normalizePlan((sub.metadata as any)?.plan)
                const status = sub.status
                const currentPeriodEnd = sub.current_period_end
                    ? new Date(sub.current_period_end * 1000).toISOString()
                    : null

                // Find associated user via subscriptions table, if possible
                const { email, userId } = await findSubscriptionRowBySubId(subscriptionId)

                // Keep subscriptions row current
                await patchSubscriptionBySubId(subscriptionId, {
                    stripe_customer_id: customerId,
                    plan,
                    status,
                    current_period_end: currentPeriodEnd,
                })

                // Gate access:
                // - active/trialing => paid plan (if plan missing, keep pending)
                // - everything else => pending
                const nextPlan: Plan = isPaidStatus(status) ? plan : "pending"
                await setUserPlan(userId, email, nextPlan)

                break
            }

            /**
             * If invoice payment fails, subscription can go past_due/unpaid.
             * We lock access immediately (strict paywall).
             */
            case "invoice.payment_failed": {
                const invoice = event.data.object as Stripe.Invoice
                const subscriptionId =
                    typeof invoice.subscription === "string" ? invoice.subscription : null
                if (!subscriptionId) break

                const { email, userId } = await findSubscriptionRowBySubId(subscriptionId)

                // Keep row current
                await patchSubscriptionBySubId(subscriptionId, { status: "past_due" })

                // Strict paywall: lock
                await setUserPlan(userId, email, "pending")
                break
            }

            /**
             * If invoice is paid, that’s a strong signal they should be unlocked.
             * (Prevents rare cases where updated event is delayed.)
             */
            case "invoice.paid": {
                const invoice = event.data.object as Stripe.Invoice
                const subscriptionId =
                    typeof invoice.subscription === "string" ? invoice.subscription : null
                if (!subscriptionId) break

                // Pull the subscription from Stripe to get authoritative metadata + status
                const sub = await stripe.subscriptions.retrieve(subscriptionId)
                const plan = normalizePlan((sub.metadata as any)?.plan)
                const status = sub.status

                const { email, userId } = await findSubscriptionRowBySubId(subscriptionId)

                await patchSubscriptionBySubId(subscriptionId, {
                    plan,
                    status,
                })

                const nextPlan: Plan = isPaidStatus(status) ? plan : "pending"
                await setUserPlan(userId, email, nextPlan)

                break
            }

            /**
             * Subscription fully ended (or deleted) -> lock access.
             */
            case "customer.subscription.deleted": {
                const sub = event.data.object as Stripe.Subscription
                const subscriptionId = sub.id

                const { email, userId } = await findSubscriptionRowBySubId(subscriptionId)

                await patchSubscriptionBySubId(subscriptionId, { status: "canceled" })
                await setUserPlan(userId, email, "pending")
                break
            }

            default:
                console.log("Ignoring event:", event.type)
        }

        await markProcessed(event.id)
    } catch (e: any) {
        console.error("❌ Webhook handler error:", e?.message || e)
        // Let Stripe retry if something transient failed
        return new Response("Webhook handler error", { status: 500 })
    }

    return new Response("ok", { status: 200 })
}

export async function GET() {
    return new Response("Method Not Allowed", { status: 405 })
}
