import { NextResponse } from "next/server"
import OpenAI from "openai"
import { createClient } from "@supabase/supabase-js"

/**
 * ENV VARS REQUIRED IN VERCEL
 * OPENAI_API_KEY
 * SUPABASE_URL
 * SUPABASE_SERVICE_ROLE_KEY
 */

// --- CORS ---
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 200, headers: corsHeaders })
}

export async function POST(req: Request) {
  try {
    // --- ENV CHECKS ---
    const openaiKey = process.env.OPENAI_API_KEY
    const supabaseUrl = process.env.SUPABASE_URL
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY

    if (!openaiKey) {
      return NextResponse.json(
        { error: "OPENAI_API_KEY is missing" },
        { status: 500, headers: corsHeaders }
      )
    }

    if (!supabaseUrl || !supabaseKey) {
      return NextResponse.json(
        { error: "Supabase credentials are missing" },
        { status: 500, headers: corsHeaders }
      )
    }

    // --- PARSE BODY ---
    const body = await req.json().catch(() => null)
    if (!body) {
      return NextResponse.json(
        { error: "Invalid JSON body" },
        { status: 400, headers: corsHeaders }
      )
    }

    const { handbookId, templateId, companyName, state, tone } = body

    if (!handbookId) {
      return NextResponse.json(
        { error: "Missing handbookId" },
        { status: 400, headers: corsHeaders }
      )
    }

    // --- INIT CLIENTS ---
    const openai = new OpenAI({ apiKey: openaiKey })
    const supabase = createClient(supabaseUrl, supabaseKey)

    // --- PROMPT ---
    const prompt = `
You are an expert HR compliance writer.

Write a complete employee handbook in Markdown format.

Template: ${templateId || "Employee Handbook"}
Company: ${companyName || "The Company"}
State: ${state || "United States"}
Tone: ${tone || "Friendly"}

Include:
- Welcome & culture
- Employment policies
- Workplace conduct
- Compensation & benefits
- Time off
- Compliance disclaimer

Use clear headings and professional formatting.
`

    // --- OPENAI CALL ---
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: prompt,
    })

    // ✅ FIX: only use output_text (avoid typed output parsing)
    const content = String(response.output_text || "")

    if (!content.trim()) {
      return NextResponse.json(
        { error: "OpenAI returned empty content" },
        { status: 500, headers: corsHeaders }
      )
    }

    // --- SAVE TO SUPABASE ---
    const { error: updateError } = await supabase
      .from("handbooks")
      .update({
        content_md: content,
        template_id: templateId || null,
        status: "draft",
      })
      .eq("id", handbookId)

    if (updateError) {
      return NextResponse.json(
        { error: updateError.message },
        { status: 500, headers: corsHeaders }
      )
    }

    return NextResponse.json(
      { content_md: content },
      { status: 200, headers: corsHeaders }
    )
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Unexpected error" },
      { status: 500, headers: corsHeaders }
    )
  }
}
