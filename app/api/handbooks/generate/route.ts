import { NextResponse } from "next/server"
import OpenAI from "openai"
import { createClient } from "@supabase/supabase-js"

/**
 * ENV VARS REQUIRED IN VERCEL (server-side):
 * - OPENAI_API_KEY
 * - SUPABASE_URL
 * - SUPABASE_SERVICE_ROLE_KEY
 *
 * Note: These are SERVER env vars. They do NOT need NEXT_PUBLIC_ prefixes.
 */

// --- CORS ---
const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
}

// Preflight
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders })
}

function jsonResponse(body: any, status = 200) {
  return NextResponse.json(body, { status, headers: corsHeaders })
}

function requireEnv(name: string) {
  const v = process.env[name]
  if (!v || !String(v).trim()) throw new Error(`${name} is required.`)
  return v
}

type GenerateBody = {
  handbookId: string
  userId?: string | null
  templateId?: string | null
  companyName?: string | null
  state?: string | null
  tone?: string | null
}

export async function POST(req: Request) {
  try {
    // Read env (do this inside handler so Vercel build doesn’t crash)
    const OPENAI_API_KEY = requireEnv("OPENAI_API_KEY")
    const SUPABASE_URL = requireEnv("SUPABASE_URL")
    const SUPABASE_SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY")

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    })

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY })

    const body = (await req.json().catch(() => null)) as GenerateBody | null
    if (!body) return jsonResponse({ error: "Invalid JSON body." }, 400)

    const handbookId = String(body.handbookId || "").trim()
    if (!handbookId) return jsonResponse({ error: "handbookId is required." }, 400)

    const templateId = String(body.templateId || "employee").trim()
    const companyName = (body.companyName ?? "").toString().trim() || "your company"
    const state = (body.state ?? "").toString().trim() || "your state"
    const tone = (body.tone ?? "Friendly").toString().trim() || "Friendly"

    // Optional ownership check (only if userId is provided)
    if (body.userId) {
      const { data: hb, error: hbErr } = await supabase
        .from("handbooks")
        .select("id, user_id")
        .eq("id", handbookId)
        .maybeSingle()

      if (hbErr) return jsonResponse({ error: hbErr.message }, 400)
      if (!hb) return jsonResponse({ error: "Handbook not found." }, 404)
      if (hb.user_id && hb.user_id !== body.userId) {
        return jsonResponse({ error: "Not authorized for this handbook." }, 403)
      }
    }

    const system = `You write employee handbooks in Markdown. Output clean Markdown only. No code fences.`
    const prompt = `
Create a complete ${templateId === "employee" ? "Employee Handbook" : "Handbook"} for "${companyName}".
State: ${state}
Tone: ${tone}

Requirements:
- Use clear section headings (H1/H2/H3).
- Include: Welcome/Intro, Company Values, Employment Basics, Compensation & Payroll, Time Off, Benefits (generic), Workplace Conduct, Anti-Harassment, Safety, IT/Acceptable Use, Remote/Hybrid (if relevant), Performance, Discipline, Termination, Acknowledgement.
- Add a short table of contents at the top with links (Markdown anchor links).
- Keep it practical; avoid legal advice disclaimers beyond a simple sentence.
`

    // Generate markdown
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    })

    const content_md = (response as any).output_text ? String((response as any).output_text) : ""
    if (!content_md.trim()) {
      return jsonResponse({ error: "Generator returned empty content." }, 500)
    }

    // Save into Supabase (safe even if your table doesn't have updated_at)
    // Only updating columns that commonly exist.
    const { error: upErr } = await supabase
      .from("handbooks")
      .update({
        // If your table uses a different column name, change this:
        content_md,
        status: "draft",
      })
      .eq("id", handbookId)

    if (upErr) {
      // If your table doesn't have content_md, you’ll see an error here.
      return jsonResponse({ error: upErr.message }, 400)
    }

    return jsonResponse({ content_md }, 200)
  } catch (err: any) {
    console.error("Generate route error:", err)
    return jsonResponse({ error: err?.message || "Server error" }, 500)
  }
}
