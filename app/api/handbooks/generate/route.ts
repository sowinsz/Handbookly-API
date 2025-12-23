import { NextResponse } from "next/server"
import OpenAI from "openai"
import { createClient } from "@supabase/supabase-js"

export const runtime = "nodejs"
// Helps avoid any caching weirdness on serverless routes
export const dynamic = "force-dynamic"

function corsHeaders(origin: string | null) {
  // Allow all origins for now (easiest while building).
  // You can lock this down later to: https://delicious-way-228843.framer.app
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
  }
}

// Preflight handler (this is what your browser is complaining about)
export async function OPTIONS(req: Request) {
  const origin = req.headers.get("origin")
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(origin),
  })
}

type Body = {
  handbookId: string
  userId?: string | null
  templateId?: string
  companyName?: string | null
  state?: string | null
  tone?: string
}

function isUuid(v: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v
  )
}

export async function POST(req: Request) {
  const origin = req.headers.get("origin")

  try {
    const supabaseUrl = process.env.SUPABASE_URL
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    const openaiKey = process.env.OPENAI_API_KEY

    if (!supabaseUrl) {
      return NextResponse.json(
        { error: "Missing env var SUPABASE_URL" },
        { status: 500, headers: corsHeaders(origin) }
      )
    }
    if (!supabaseServiceRoleKey) {
      return NextResponse.json(
        { error: "Missing env var SUPABASE_SERVICE_ROLE_KEY" },
        { status: 500, headers: corsHeaders(origin) }
      )
    }
    if (!openaiKey) {
      return NextResponse.json(
        { error: "Missing env var OPENAI_API_KEY" },
        { status: 500, headers: corsHeaders(origin) }
      )
    }

    const body = (await req.json()) as Body

    const handbookId = String(body.handbookId || "")
    const templateId = String(body.templateId || "employee")
    const companyName = (body.companyName || "").trim() || "Your Company"
    const state = (body.state || "").trim() || "your state"
    const tone = String(body.tone || "Friendly")

    if (!handbookId) {
      return NextResponse.json(
        { error: "Missing handbookId" },
        { status: 400, headers: corsHeaders(origin) }
      )
    }

    if (!isUuid(handbookId)) {
      return NextResponse.json(
        { error: "handbookId must be a UUID" },
        { status: 400, headers: corsHeaders(origin) }
      )
    }

    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey)

    // Confirm handbook exists
    const { data: hb, error: hbErr } = await supabase
      .from("handbooks")
      .select("id, title")
      .eq("id", handbookId)
      .maybeSingle()

    if (hbErr) {
      return NextResponse.json(
        { error: hbErr.message },
        { status: 400, headers: corsHeaders(origin) }
      )
    }
    if (!hb) {
      return NextResponse.json(
        { error: "Handbook not found" },
        { status: 404, headers: corsHeaders(origin) }
      )
    }

    const prompt = `
You are writing an employee handbook in Markdown.

Template: ${templateId}
Company: ${companyName}
State: ${state}
Tone: ${tone}

Return a complete handbook as Markdown with:
- Table of contents
- Clear headings (##)
- Core HR policies
- Benefits overview
- Code of conduct
- Time off + leave
- Remote work policy
- Anti-harassment and equal opportunity
- Confidentiality + data security
- Discipline + termination
- Acknowledgement section

Output ONLY Markdown (no backticks code fences).
`.trim()

    const openai = new OpenAI({ apiKey: openaiKey })

    // Responses API: safest way is output_text
    const ai = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: prompt,
    })

    const content_md = (ai.output_text || "").trim()

    if (!content_md) {
      return NextResponse.json(
        { error: "Generator returned empty content." },
        { status: 500, headers: corsHeaders(origin) }
      )
    }

    // SAVE: adjust column name if needed (see note below)
    const { error: updateErr } = await supabase
      .from("handbooks")
      .update({
        content_md,
        updated_at: new Date().toISOString(),
      })
      .eq("id", handbookId)

    if (updateErr) {
      return NextResponse.json(
        { error: updateErr.message },
        { status: 400, headers: corsHeaders(origin) }
      )
    }

    return NextResponse.json(
      { content_md },
      { status: 200, headers: corsHeaders(origin) }
    )
  } catch (err: any) {
    console.error("Generate error:", err)
    return NextResponse.json(
      { error: err?.message || "Unknown error" },
      { status: 500, headers: corsHeaders(origin) }
    )
  }
}
