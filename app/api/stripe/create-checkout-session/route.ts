import Stripe from "stripe"

export const runtime = "nodejs"

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
    apiVersion: "2023-10-16",
})

function corsHeaders(origin: string | null) {
    // ✅ For Framer + your API: reflect origin when present; otherwise allow all.
    // If you want to lock this down later, replace "*" with your Framer domain(s).
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

type Plan = "starter" | "growth" | "business"

const allowedPlans: Plan[] = ["starter", "growth", "business"]

function isValidUrl(url: string) {
    try {
        const u = new URL(url)
        return u.protocol === "https:" || u.protocol === "http:"
    } catch {
        return false
    }
}

function getPriceIdForPlan(plan: Plan) {
    // ✅ Don’t use NEXT_PUBLIC_* on the server if you can avoid it.
    // Keep existing env names for compatibility, but prefer non-public names if you add them.
    const starter =
        process.env.STRIPE_STARTER_PRICE_ID ||
        process.env.NEXT_PUBLIC_STRIPE_STARTER_PRICE_ID
    const growth =
        process.env.STRIPE_GROWTH_PRICE_ID ||
        process.env.NEXT_PUBLIC_STRIPE_GROWTH_PRICE_ID
    const business =
        process.env.STRIPE_BUSINESS_PRICE_ID ||
        process.env.NEXT_PUBLIC_STRIPE_BUSINESS_PRICE_ID

    const priceId =
        plan === "starter" ? starter : plan === "growth" ? growth : business

    return priceId || null
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

        const planRaw = (body?.plan ?? "").toString().toLowerCase().trim()
        const plan = planRaw as Plan

        const successUrl = body?.successUrl ? String(body.successUrl) : ""
        const cancelUrl = body?.cancelUrl ? String(body.cancelUrl) : ""

        const userId = body?.userId ? String(body.userId) : ""
        const email = body?.email ? String(body.email) : ""

        // ✅ Validate plan
        if (!allowedPlans.includes(plan)) {
            return Response.json(
                { error: `plan must be one of: ${allowedPlans.join(", ")}` },
                { status: 400, headers: corsHeaders(origin) }
            )
        }

        // ✅ Validate URLs (prevents obvious mistakes and bad redirects)
        if (!successUrl || !cancelUrl) {
            return Response.json(
                { error: "Missing successUrl or cancelUrl" },
                { status: 400, headers: corsHeaders(origin) }
            )
        }
        if (!isValidUrl(successUrl) || !isValidUrl(cancelUrl)) {
            return Response.json(
                { error: "successUrl and cancelUrl must be valid http(s) URLs" },
                { status: 400, headers: corsHeaders(origin) }
            )
        }

        // ✅ Validate user linkage (important for strict paywall + webhook mapping)
        if (!userId) {
            return Response.json(
                { error: "Missing userId" },
                { status: 400, headers: corsHeaders(origin) }
            )
        }

        // Price lookup
        const price = getPriceIdForPlan(plan)
        if (!price) {
            return Response.json(
                {
                    error: "Missing Stripe price ID env var for selected plan",
                    detail:
                        "Set STRIPE_*_PRICE_ID (preferred) or NEXT_PUBLIC_STRIPE_*_PRICE_ID in Vercel.",
                },
                { status: 500, headers: corsHeaders(origin) }
            )
        }

        // ✅ Add optional helpful metadata: these show up in Stripe + in your webhook
        const meta: Record<string, string> = {
            plan,
            userId,
        }
        if (email) meta.email = email

        // ✅ Stronger success flow:
        // Encourage adding session_id so you can troubleshoot later if needed.
        // (Your dashboard uses upgraded=1; this doesn't break anything.)
        const successWithSession =
            successUrl.includes("{CHECKOUT_SESSION_ID}")
                ? successUrl
                : successUrl + (successUrl.includes("?") ? "&" : "?") + "session_id={CHECKOUT_SESSION_ID}"

        const session = await stripe.checkout.sessions.create({
            mode: "subscription",
            line_items: [{ price, quantity: 1 }],

            success_url: successWithSession,
            cancel_url: cancelUrl,

            customer_email: email || undefined,
            client_reference_id: userId || undefined,

            // Metadata on the CHECKOUT SESSION (nice for debugging)
            metadata: meta,

            // 🔑 Metadata on the SUBSCRIPTION is what most webhooks read reliably
            subscription_data: {
                metadata: meta,
            },

            // Optional UX polish (safe defaults)
            allow_promotion_codes: true,
            billing_address_collection: "auto",
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
