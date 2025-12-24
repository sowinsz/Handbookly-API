import { NextResponse } from "next/server"
import OpenAI from "openai"
import { createClient } from "@supabase/supabase-js"

/**
 * ENV VARS (Vercel)
 * - OPENAI_API_KEY
 * - SUPABASE_URL  (or NEXT_PUBLIC_SUPABASE_URL)
 * - SUPABASE_SERVICE_ROLE_KEY
 *
 * NOTE: This route uses the SERVICE ROLE key, so it bypasses RLS.
 * Do NOT expose these env vars to the browser.
 */

function corsHeaders(req: Request) {
  const origin = req.headers.get("origin") || "*"

  // If you want to lock this down, replace "*" behavior with a whitelist:
  // const allowed = new Set(["https://delicious-way-228843.framer.app"])
  // const allowOrigin = allowed.has(origin) ? origin : "null"
  // return { "Access-Control-Allow-Origin": allowOrigin, ... }

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    // If you ever send cookies/credentials, uncomment:
    // "Access-Control-Allow-Credentials": "true",
  }
}

function json(req: Request, status: number, body: any) {
  return NextResponse.json(body, { status, headers: corsHeaders(req) })
}

function isUuid(v: unknown) {
  if (typeof v !== "string") return false
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v
  )
}

export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) })
}

// Helpful: visiting the URL in a browser will hit GET.
// This avoids confusion with a raw 404.
export async function GET(req: Request) {
  return json(req, 405, {
    error: "Method Not Allowed. Use POST with JSON body.",
  })
}

export async function POST(req: Request) {
  try {
    const supabaseUrl =
      process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    const openaiKey = process.env.OPENAI_API_KEY

    if (!supabaseUrl) return json(req, 500, { error: "SUPABASE_URL is required" })
    if (!serviceRoleKey)
      return json(req, 500, { error: "SUPABASE_SERVICE_ROLE_KEY is required" })
    if (!openaiKey) return json(req, 500, { error: "OPENAI_API_KEY is required" })

    const payload = await req.json().catch(() => null)
    if (!payload) return json(req, 400, { error: "Invalid JSON body." })

    const {
      handbookId,
      userId,
      templateId,
      companyName,
      state,
      tone,
    }: {
      handbookId?: string
      userId?: string | null
      templateId?: string | null
      companyName?: string | null
      state?: string | null
      tone?: string | null
    } = payload

    if (!handbookId) return json(req, 400, { error: "handbookId is required" })
    if (!isUuid(handbookId))
      return json(req, 400, { error: `handbookId must be a uuid (got "${handbookId}")` })

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    })

    // Optional sanity check: make sure handbook exists
    const { data: existing, error: fetchErr } = await supabase
      .from("handbooks")
      .select("id")
      .eq("id", handbookId)
      .maybeSingle()

    if (fetchErr) return json(req, 500, { error: fetchErr.message })
    if (!existing) return json(req, 404, { error: "Handbook not found." })

    const openai = new OpenAI({ apiKey: openaiKey })

    const templateName = templateId || "employee"
    const company = companyName?.trim() || "Your Company"
    const st = state?.trim() || "your state"
    const toneName = (tone || "Friendly").trim()

    const prompt = `
Create an ${templateName} employee handbook in Markdown.

Company name: ${company}
State: ${st}
Tone: ${toneName}

Requirements:
- Start with a short welcome
- Include a Table of Contents with anchor links
- Include common HR sections: At-Will, Equal Employment, Anti-Harassment, Reporting Procedure, Code of Conduct, Attendance, PTO/Leave, Benefits Overview, Workplace Safety, Security, Confidentiality, Acceptable Use, Remote Work, Discipline, Acknowledgements
- Include a State Addendum section for ${st}
- Keep it readable and practical
Return ONLY Markdown.
`.trim()

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: prompt,
    })

    // IMPORTANT: avoid using response.output?.[0]?.content... (that caused your TS error)
    const content_md = (response.output_text || "").trim()

    if (!content_md) {
      return json(req, 500, { error: "Generator returned empty content." })
    }

    // Save into Supabase
    const { error: updateErr } = await supabase
      .from("handbooks")
      .update({
        content_md,
        template_id: templateId || null,
        // If your table has these columns and you want to store them:
        // company_name: companyName || null,
        // state: state || null,
        // tone: tone || null,
        // user_id: userId || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", handbookId)

    if (updateErr) return json(req, 500, { error: updateErr.message })

    return json(req, 200, { content_md })
  } catch (err: any) {
    return json(req, 500, { error: err?.message || "Unknown server error." })
  }
}
