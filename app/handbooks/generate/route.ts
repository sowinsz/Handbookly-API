import OpenAI from "openai"
import { createClient } from "@supabase/supabase-js"

export const runtime = "nodejs"

function corsHeaders(origin: string | null) {
    // In production you can lock this down to your Framer domain.
    return {
        "Access-Control-Allow-Origin": origin || "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
    }
}

export async function OPTIONS(req: Request) {
    return new Response(null, {
        status: 204,
        headers: corsHeaders(req.headers.get("origin")),
    })
}

type GenerateBody = {
    handbookId: string
    userId?: string | null
    templateId?: string | null
    companyName?: string | null
    state?: string | null
    tone?: "Friendly" | "Formal" | "Direct" | string
}

function buildPrompt(input: {
    templateId?: string | null
    companyName?: string | null
    state?: string | null
    tone?: string | null
}) {
    const template = (input.templateId || "employee_handbook").toLowerCase()
    const company = input.companyName?.trim() || "the company"
    const state = input.state?.trim() || "the applicable state"
    const tone = input.tone?.trim() || "Friendly"

    // Keep it simple for now. We can expand templates later.
    const templateDescription =
        template === "employee_handbook"
            ? "an Employee Handbook"
            : `a ${template.replace(/_/g, " ")}`

    return `
You are an expert HR policy writer.

Write ${templateDescription} in Markdown for ${company}.
The handbook should be suitable for a US-based company and reference ${state} where appropriate.
Tone: ${tone}.

Requirements:
- Output ONLY Markdown.
- Use clear headings, bullet lists, and concise policy language.
- Include these sections at minimum:
  1) Welcome / Company Overview
  2) Employment Basics (at-will, equal opportunity, anti-harassment)
  3) Workplace Conduct
  4) Time Off & Attendance
  5) Compensation & Benefits (high-level)
  6) Remote/Hybrid (if applicable as a general policy)
  7) Safety & Security
  8) IT / Acceptable Use
  9) Complaints / Reporting
  10) Acknowledgement (placeholder)
- Add a brief disclaimer that it is not legal advice.
`.trim()
}

export async function POST(req: Request) {
    const origin = req.headers.get("origin")
    const headers = corsHeaders(origin)

    try {
        const supabaseUrl =
            process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
        const supabaseServiceRole =
            process.env.SUPABASE_SERVICE_ROLE_KEY ||
            process.env.SUPABASE_SERVICE_KEY

        if (!supabaseUrl) {
            return Response.json(
                { error: "Missing SUPABASE_URL env var." },
                { status: 500, headers }
            )
        }
        if (!supabaseServiceRole) {
            return Response.json(
                { error: "Missing SUPABASE_SERVICE_ROLE_KEY env var." },
                { status: 500, headers }
            )
        }

        const openaiKey = process.env.OPENAI_API_KEY
        if (!openaiKey) {
            return Response.json(
                { error: "Missing OPENAI_API_KEY env var." },
                { status: 500, headers }
            )
        }

        const body = (await req.json()) as GenerateBody

        if (!body?.handbookId) {
            return Response.json(
                { error: "handbookId is required." },
                { status: 400, headers }
            )
        }

        const supabase = createClient(supabaseUrl, supabaseServiceRole, {
            auth: { persistSession: false },
        })

        // (Optional but recommended) Ensure the handbook belongs to the user
        // If userId is not provided, we skip this check.
        if (body.userId) {
            const { data: hb, error: hbErr } = await supabase
                .from("handbooks")
                .select("id, user_id")
                .eq("id", body.handbookId)
                .maybeSingle()

            if (hbErr) {
                return Response.json(
                    { error: hbErr.message || "Could not load handbook." },
                    { status: 500, headers }
                )
            }
            if (!hb) {
                return Response.json(
                    { error: "Handbook not found." },
                    { status: 404, headers }
                )
            }
            if (hb.user_id !== body.userId) {
                return Response.json(
                    { error: "Not allowed." },
                    { status: 403, headers }
                )
            }
        }

        const prompt = buildPrompt({
            templateId: body.templateId,
            companyName: body.companyName,
            state: body.state,
            tone: body.tone,
        })

        const openai = new OpenAI({ apiKey: openaiKey })

        // Model choice: keep cheap/fast. You can change later.
        const aiResp = await openai.responses.create({
            model: "gpt-4o-mini",
            input: prompt,
        })

        const content_md = (aiResp.output_text || "").trim()
        if (!content_md) {
            return Response.json(
                { error: "Generator returned empty content." },
                { status: 500, headers }
            )
        }

        // Save markdown back to Supabase
        const { error: updErr } = await supabase
            .from("handbooks")
            .update({
                content_md,
                template_id: body.templateId || null,
                updated_at: new Date().toISOString(),
            })
            .eq("id", body.handbookId)

        if (updErr) {
            return Response.json(
                { error: updErr.message || "Could not save content." },
                { status: 500, headers }
            )
        }

        return Response.json({ content_md }, { status: 200, headers })
    } catch (e: any) {
        return Response.json(
            { error: e?.message || "Unexpected error." },
            { status: 500, headers }
        )
    }
}

