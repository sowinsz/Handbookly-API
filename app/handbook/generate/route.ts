// app/api/handbooks/generate/route.ts
import OpenAI from "openai"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * CORS
 * - Framer runs on a different origin than your Vercel API, so you MUST answer preflight (OPTIONS)
 * - We echo the request Origin (when allowed) so the browser is happy.
 */
const ALLOWED_ORIGINS = new Set<string>([
  "https://delicious-way-228843.framer.app",
  // add any other Framer domains you use:
  // "https://your-custom-domain.com",
  "http://localhost:3000",
  "http://localhost:5173",
])

function corsHeaders(origin: string | null) {
  const allowOrigin =
    origin && (ALLOWED_ORIGINS.has(origin) || origin.endsWith(".framer.app"))
      ? origin
      : "*" // fallback (fine here because we are not using cookies/credentials)

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  }
}

export async function OPTIONS(req: Request) {
  const origin = req.headers.get("origin")
  return new Response(null, { status: 204, headers: corsHeaders(origin) })
}

type Tone = "friendly" | "formal" | "direct"

type Body = {
  // Your editor sends these:
  templateId?: string
  companyName?: string | null
  state?: string | null
  tone?: Tone

  // Optional (supported if you want to send them later):
  handbookId?: string
  userId?: string | null
}

function safeStr(v: any, fallback = "") {
  if (typeof v === "string") return v
  if (v == null) return fallback
  return String(v)
}

function normalizeTone(v: any): Tone {
  const t = safeStr(v, "friendly").toLowerCase()
  return t === "formal" ? "formal" : t === "direct" ? "direct" : "friendly"
}

function templateName(id: string) {
  const x = (id || "").toLowerCase()
  if (x === "culture_playbook") return "Culture Playbook"
  if (x === "remote_work") return "Remote Work Policy Pack"
  return "Employee Handbook"
}

/**
 * If OPENAI_API_KEY is not set, we return a deterministic placeholder draft
 * so the UI still works and you can test end-to-end.
 */
function fallbackDraft(args: {
  templateId: string
  companyName: string
  state: string
  tone: Tone
}) {
  const tn =
    args.tone === "formal"
      ? "Formal"
      : args.tone === "direct"
        ? "Direct"
        : "Friendly"

  return `# ${args.companyName} — ${templateName(args.templateId)}

> **Jurisdiction:** ${args.state}  
> **Tone:** ${tn}

## 1. Welcome
Welcome to **${args.companyName}**. This handbook explains key policies, expectations, and resources.

## 2. Equal Employment Opportunity
We are committed to a workplace free from discrimination and harassment.

## 3. Employment Basics
- At-will employment (where applicable)
- Work hours, attendance, and timekeeping
- Performance expectations

## 4. Compensation & Benefits
- Pay schedule
- Benefits eligibility and enrollment
- Paid time off overview

## 5. Code of Conduct
- Professional behavior
- Conflicts of interest
- Confidentiality

## 6. Leave Policies
Outline federal and ${args.state}-specific leave practices (where applicable).

## 7. Safety
We prioritize safety and require reporting hazards and incidents promptly.

## 8. Acknowledgement
By continuing employment, you acknowledge you’ve received and understood this handbook.

---

*This is placeholder content because **OPENAI_API_KEY** is not set yet.*`
}

export async function POST(req: Request) {
  const origin = req.headers.get("origin")

  try {
    const body = (await req.json().catch(() => null)) as Body | null
    if (!body) {
      return Response.json(
        { error: "Missing JSON body" },
        { status: 400, headers: corsHeaders(origin) }
      )
    }

    const templateId = safeStr(body.templateId, "employee_handbook")
    const companyName = safeStr(body.companyName, "Your Company").trim()
    const state = safeStr(body.state, "United States").trim()
    const tone = normalizeTone(body.tone)

    // ✅ If no OpenAI key yet, return a usable draft so your UI works
    if (!process.env.OPENAI_API_KEY) {
      const content_md = fallbackDraft({ templateId, companyName, state, tone })
      return Response.json(
        { content_md },
        { status: 200, headers: corsHeaders(origin) }
      )
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

    const toneGuide =
      tone === "formal"
        ? "Write in a formal HR-compliance tone. Crisp, neutral, policy-forward."
        : tone === "direct"
          ? "Write in a direct, no-nonsense tone. Short sentences, clear bullets."
          : "Write in a friendly, approachable tone while staying professional."

    const prompt = `
You are an expert HR policy writer.

Create a complete markdown handbook draft for:
- Company: ${companyName}
- State/jurisdiction focus: ${state}
- Template: ${templateName(templateId)}
- Tone: ${tone}

Requirements:
- Output ONLY markdown (no code fences).
- Use clear headings and a table of contents at the top.
- Include: EEO, anti-harassment, accommodation, attendance, timekeeping, pay, benefits overview, PTO, sick leave, leave basics, remote work (if relevant), confidentiality, data security, conduct, conflicts of interest, safety, complaint/reporting procedure, discipline, separation, acknowledgements.
- Add a short disclaimer that it is not legal advice and should be reviewed by counsel.
- Avoid making false legal claims. Use "where applicable" language when uncertain.
${toneGuide}
`.trim()

    const result = await client.responses.create({
      model: "gpt-4.1-mini",
      input: prompt,
    })

    // Try common locations for text output
    const content_md =
      (result.output_text && result.output_text.trim()) ||
      (Array.isArray(result.output)
        ? result.output
            .flatMap((o: any) => o?.content || [])
            .map((c: any) => c?.text)
            .filter(Boolean)
            .join("\n")
            .trim()
        : "")

    if (!content_md) {
      return Response.json(
        { error: "Generator returned empty content" },
        { status: 500, headers: corsHeaders(origin) }
      )
    }

    return Response.json(
      { content_md },
      { status: 200, headers: corsHeaders(origin) }
    )
  } catch (err: any) {
    return Response.json(
      { error: "Server error", detail: err?.message || String(err) },
      { status: 500, headers: corsHeaders(origin) }
    )
  }
}
