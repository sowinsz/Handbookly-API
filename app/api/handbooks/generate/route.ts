import { NextResponse } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function mustEnv(name: string) {
  const v = process.env[name]
  if (!v) throw new Error(`Missing env var: ${name}`)
  return v
}

type Tone = "friendly" | "formal" | "direct"

export async function POST(req: Request) {
  try {
    const OPENAI_API_KEY = mustEnv("OPENAI_API_KEY")

    const body = await req.json().catch(() => null)
    const handbookId = body?.handbookId ? String(body.handbookId) : null
    const templateId = body?.templateId ? String(body.templateId) : "employee_handbook"
    const companyName = body?.companyName ? String(body.companyName) : "Your Company"
    const state = body?.state ? String(body.state) : "United States"
    const tone = (body?.tone ? String(body.tone) : "friendly") as Tone

    const detailLevel = body?.detailLevel ? String(body.detailLevel) : "beefy"
    const sections = Number.isFinite(body?.sections) ? Number(body.sections) : 14
    const includeTables = Boolean(body?.includeTables ?? true)
    const includeFAQ = Boolean(body?.includeFAQ ?? true)
    const includeTOC = Boolean(body?.includeTOC ?? true)

    if (!handbookId) {
      return NextResponse.json({ error: "Missing handbookId" }, { status: 400 })
    }

    const toneStyle =
      tone === "formal"
        ? "Formal, HR-compliant, neutral, and precise."
        : tone === "direct"
          ? "Direct, concise, clear, and no fluff."
          : "Friendly, welcoming, and modern while still professional."

    // ✅ Beefier prompt: more comprehensive + structured markdown
    const system = `You are a senior HR policy writer. You write clear, compliant, practical employee handbooks in Markdown. 
You avoid legal advice; you include disclaimers and suggest consulting counsel for local requirements.
You write with consistent headings, bullets, tables where helpful, and actionable details.`

    const user = `
Create a HIGH-QUALITY, DETAILED employee handbook in Markdown for:

Company: "${companyName}"
Jurisdiction / State: "${state}"
Template: "${templateId}"
Tone: ${toneStyle}

Quality target: ${detailLevel === "beefy" ? "very detailed" : "standard"}
Number of major sections target: ~${sections}

REQUIREMENTS:
- Use Markdown headings with #, ##, ### so the TOC can be generated.
- Start with an H1 title.
${includeTOC ? "- Include a short '## Table of Contents' section near the top (bulleted list of section links with plain text; do not rely on actual markdown anchor links)." : ""}
- Include an intro + how to use the handbook.
- Include at-will employment disclaimer (where applicable) and non-contractual disclaimer.
- Include sections for: Values/Culture, Equal Opportunity/Anti-Discrimination, Anti-Harassment, Code of Conduct, Attendance, Remote/Hybrid, Time Off, Holidays, Benefits overview, Compensation basics, Performance, Disciplinary, Confidentiality, Security, Acceptable Use, Social Media, Safety, Complaints/Reporting, Separation/Offboarding.
- Add state-specific notes where relevant for "${state}" but do not fabricate exact statutes.
- Add examples (e.g., what is harassment, reporting steps, acceptable use examples, etc.).
${includeTables ? "- Include at least 2 helpful tables (e.g., PTO tiers, disciplinary steps, reporting channels, role responsibilities)." : ""}
${includeFAQ ? "- End with a short '## FAQ' section (8-12 Q&As)." : ""}
- End with an acknowledgement section employees can sign.

OUTPUT:
Return ONLY the Markdown content. No preamble.
`.trim()

    // ✅ OpenAI Responses API (HTTP)
    // Model defaults to gpt-4o-mini unless you set OPENAI_MODEL in env
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini"

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.4,
      }),
    })

    const json = await r.json().catch(() => null)

    if (!r.ok) {
      return NextResponse.json(
        { error: "OpenAI request failed", detail: json?.error?.message || JSON.stringify(json) },
        { status: 500 }
      )
    }

    // Try to pull text from Responses output
    const text =
      json?.output_text ||
      (Array.isArray(json?.output)
        ? json.output
            .flatMap((o: any) => o?.content || [])
            .map((c: any) => c?.text)
            .filter(Boolean)
            .join("\n")
        : "")

    const content_md = String(text || "").trim()

    if (!content_md) {
      return NextResponse.json({ error: "OpenAI returned empty content" }, { status: 500 })
    }

    return NextResponse.json({ content_md }, { status: 200 })
  } catch (e: any) {
    return NextResponse.json(
      { error: "Server error", detail: e?.message || String(e) },
      { status: 500 }
    )
  }
}

export async function GET() {
  return new Response("Method Not Allowed", { status: 405 })
}
