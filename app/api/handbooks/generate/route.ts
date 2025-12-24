import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

// IMPORTANT: Put your Framer site origin here (and any custom domain later).
// You can also leave "*" if you don't use cookies/credentials.
const ALLOWED_ORIGINS = [
  "https://delicious-way-228843.framer.app",
  // If you add a custom domain later, add it here:
  // "https://handbookly.ai",
]

function corsHeaders(req: Request) {
  const origin = req.headers.get("origin") || ""
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : "*"

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    // Helps proxies/CDNs behave when echoing Origin
    "Vary": "Origin",
  }
}

function json(req: Request, body: any, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: corsHeaders(req),
  })
}

function text(req: Request, body: string, status = 200) {
  return new NextResponse(body, {
    status,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "text/plain; charset=utf-8",
    },
  })
}

function isUuid(v: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v
  )
}

export async function OPTIONS(req: Request) {
  // Preflight must return the CORS headers
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) })
}

export async function GET(req: Request) {
  // This is just so visiting the URL in a browser doesn't look like "404".
  // Your app should use POST.
  return json(req, { ok: true, route: "/api/handbooks/generate" }, 200)
}

export async function POST(req: Request) {
  try {
    const headers = corsHeaders(req)

    const supabaseUrl = process.env.SUPABASE_URL
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    const openaiKey = process.env.OPENAI_API_KEY

    if (!supabaseUrl) return NextResponse.json({ error: "SUPABASE_URL is missing" }, { status: 500, headers })
    if (!supabaseServiceRoleKey) return NextResponse.json({ error: "SUPABASE_SERVICE_ROLE_KEY is missing" }, { status: 500, headers })
    if (!openaiKey) return NextResponse.json({ error: "OPENAI_API_KEY is missing" }, { status: 500, headers })

    const payload = await req.json().catch(() => null)
    if (!payload) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers })

    const {
      handbookId,
      userId, // optional (you can enforce ownership if you want)
      templateId,
      companyName,
      state,
      tone,
    } = payload

    if (!handbookId || typeof handbookId !== "string")
      return NextResponse.json({ error: "handbookId is required" }, { status: 400, headers })

    if (!isUuid(handbookId))
      return NextResponse.json({ error: "handbookId must be a UUID" }, { status: 400, headers })

    const template = String(templateId || "employee").toLowerCase()
    const company = String(companyName || "Your Company").trim()
    const usState = String(state || "your state").trim()
    const style = String(tone || "Friendly").trim()

    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
    })

    // Confirm the handbook exists (optional, but helps errors be clear)
    const { data: hb, error: hbErr } = await supabase
      .from("handbooks")
      .select("id, user_id")
      .eq("id", handbookId)
      .maybeSingle()

    if (hbErr) {
      return NextResponse.json({ error: hbErr.message }, { status: 500, headers })
    }
    if (!hb) {
      return NextResponse.json({ error: "Handbook not found" }, { status: 404, headers })
    }

    // Optional ownership check (recommended)
    if (userId && hb.user_id && String(hb.user_id) !== String(userId)) {
      return NextResponse.json({ error: "Not allowed for this handbook" }, { status: 403, headers })
    }

    // Prompt
    const system = `You are an expert HR/compliance writer. Output ONLY markdown. No JSON.`
    const prompt = `
Generate a complete employee handbook in markdown.

Context:
- Template: ${template}
- Company: ${company}
- State: ${usState}
- Tone: ${style}

Requirements:
- Start with a clear title and a table of contents with anchor links.
- Include core policies: at-will employment disclaimer, equal employment opportunity, anti-harassment, reporting procedure, code of conduct, attendance, PTO/leave (keep it general), benefits overview, workplace safety, security, confidentiality, acceptable use, remote work (optional section), discipline, and acknowledgements.
- Keep it practical and readable.
- Add a short "State addendum: ${usState}" section near the end (general guidance; avoid making legal claims).
- No legal advice disclaimer at the end.
`.trim()

    // Call OpenAI Responses API via fetch (no openai npm dependency)
    const aiResp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
      }),
    })

    const aiJson: any = await aiResp.json().catch(() => null)

    if (!aiResp.ok) {
      return NextResponse.json(
        { error: aiJson?.error?.message || "OpenAI request failed" },
        { status: 500, headers }
      )
    }

    const content =
      String(aiJson?.output_text || "").trim() ||
      // fallback extraction if output_text ever missing
      String(aiJson?.output?.map((o: any) => o?.content?.map((c: any) => c?.text || "").join("")).join("\n") || "").trim()

    if (!content) {
      return NextResponse.json(
        { error: "Generator returned empty content" },
        { status: 500, headers }
      )
    }

    // Save to Supabase
    const { error: upErr } = await supabase
      .from("handbooks")
      .update({
        content_md: content,
        template_id: template,
        updated_at: new Date().toISOString(),
      })
      .eq("id", handbookId)

    if (upErr) {
      return NextResponse.json({ error: upErr.message }, { status: 500, headers })
    }

    return NextResponse.json({ content_md: content }, { status: 200, headers })
  } catch (e: any) {
    // Ensure CORS headers even on unexpected errors
    const headers = corsHeaders(new Request("http://localhost"))
    return NextResponse.json(
      { error: e?.message || "Unknown error" },
      { status: 500, headers }
    )
  }
}
