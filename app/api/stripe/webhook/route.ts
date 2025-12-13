import Stripe from "stripe";
import { headers } from "next/headers";

export const runtime = "nodejs"; // keep (Stripe lib needs node)
export const dynamic = "force-dynamic"; // webhook = always dynamic

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2024-06-20",
});

export async function POST(req: Request) {
  const sig = headers().get("stripe-signature");
  const body = await req.text(); // ✅ raw body for signature verification

  if (!sig) {
    return new Response("Missing stripe-signature header", { status: 400 });
  }

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err: any) {
    console.error("❌ Webhook signature verification failed:", err.message);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  // ✅ VERIFIED: safe to trust event now
  console.log("✅ Stripe event verified:", event.type);

  // TODO: handle events (start simple)
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    console.log("✅ checkout.session.completed:", {
      id: session.id,
      customer: session.customer,
      subscription: session.subscription,
      email: session.customer_details?.email,
    });

    // later: write to Supabase here
  }

  return new Response("ok", { status: 200 });
}

export async function GET() {
  return new Response("Method Not Allowed", { status: 405 });
}
