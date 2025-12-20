import { NextResponse } from "next/server"
import OpenAI from "openai"
import { createClient } from "@supabase/supabase-js"

export const runtime = "nodejs"

// 🔐 Env vars (set these in Vercel too)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
})

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// 🌍 CORS helper
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  }
}

// ✅ Required for preflight
export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() })
}

export async function POST(req: Request) {
  try {
    const body = await req.json()

    const {
      handbookId,
      userId,
      templateId,
      companyName,
      state,
      tone,
    } = body

    if (!handbookId || !userId) {
      return NextResponse.json(
        { error: "Missing handbookId or userId" },
        { status: 400, headers: corsHeaders() }
      )
    }

    const prompt = `
Write a professional employee handbook in Markdown.

Company: ${companyName || "The Company"}
State: ${state || "United States"}
Tone: ${tone || "Friendly"}

Include sections for:
- Introduction
- Employment policies
- Code of conduct
- Benefits
- Time off
- Compliance disclaimer

Use clear headings and bullet points.
`

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    })

    const content_md =
      completion.choices[0]?.message?.content?.trim() || ""

    if (!content_md) {
      return NextResponse.json(
        { error: "AI returned empty content" },
        { status: 500, headers: corsHeaders() }
      )
    }

    // 💾 Save to Supabase
    const { error: updateError } = await supabase
      .from("handbooks")
      .update({
        content_md,
        template_id: templateId || null,
        status: "draft",
      })
      .eq("id", handbookId)
      .eq("user_id", userId)

    if (updateError) {
      console.error(updateError)
      return NextResponse.json(
        { error: "Failed to save handbook" },
        { status: 500, headers: corsHeaders() }
      )
    }

    return NextResponse.json(
      { content_md },
      { headers: corsHeaders() }
    )
  } catch (err) {
    console.error(err)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: corsHeaders() }
    )
  }
}
