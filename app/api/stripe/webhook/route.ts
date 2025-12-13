import Stripe from "stripe";
import { headers } from "next/headers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function POST(req: Request) {
  const sig = headers().get("stripe-signature");
  const body = await req.text();

  if (!sig) return new Response("Missing stripe-signature", { status: 400 });

  const secrets = [
    process.env.STRIPE_WEBHOOK_SECRET,        // Dashboard endpoint secret
    process.env.STRIPE_CLI_WEBHOOK_SECRET,    // CLI listen secret
  ].filter(Boolean) as string[];

  let event: Stripe.Event | null = null;
  let lastErr: any = null;

  for (const secret of secrets) {
    try {
      event = stripe.webhooks.constructEvent(body, sig, secret);
      break; // ✅ verified
    } catch (err) {
      lastErr = err;
    }
  }

  if (!event) {
    console.error("❌ Webhook signature verification failed:", lastErr?.message);
    return new Response(`Webhook Error: ${lastErr?.message ?? "Invalid signature"}`, { status: 400 });
  }

  console.log("✅ Stripe event verified:", event.type);
  return new Response("ok", { status: 200 });
}


export async function GET() {
  return new Response("Method Not Allowed", { status: 405 });
}
