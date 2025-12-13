export const runtime = "nodejs"

export async function POST() {
  console.log("HIT app route webhook")
  return new Response("ok", { status: 200 })
}

export async function GET() {
  return new Response("Method Not Allowed", { status: 405 })
}
