import { NextResponse } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Tone = "friendly" | "formal" | "direct"

function titleCase(s: string) {
  return s.replace(/\w\S*/g, (t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase())
}

function buildMarkdown(opts: {
  templateId: string
  companyName?: string | null
  state?: string | null
  tone: Tone
}) {
  const company = (opts.companyName || "Your Company").trim()
  const state = (opts.state || "your state").trim()
  const tone = opts.tone

  const voice =
    tone === "formal"
      ? "This document outlines official policies and expectations."
      : tone === "direct"
        ? "Read this. Follow it. Ask questions if anything is unclear."
        : "Welcome! This handbook is here to make things clear and easy."

  if (opts.templateId === "security-policy-pack") {
    return `# ${company} — Security Policy Pack

_${voice}_

## 1. Access Control
- Use unique credentials (no shared logins).
- Enable MFA for all accounts where available.
- Request access through approved channels.

## 2. Password Policy
- Use strong passwords (12+ characters recommended).
- Use a password manager.
- Never reuse passwords across services.

## 3. Device & Endpoint Security
- Keep OS and apps up to date.
- Full-disk encryption required on laptops.
- Report lost or stolen devices immediately.

## 4. Data Handling
- Classify data (Public / Internal / Confidential).
- Do not email confidential data to personal accounts.
- Store company data only in approved tools.

## 5. Incident Response
If you suspect a breach:
1. Stop and contain (disconnect device if needed).
2. Report immediately to the security contact.
3. Do not delete evidence.

## 6. Compliance Notes (${titleCase(state)})
This draft is a starting point. Review with counsel for ${titleCase(state)} requirements.

--- 
_Last updated: ${new Date().toLocaleDateString()}_
`
  }

  if (opts.templateId === "sop-operations") {
    return `# ${company} — Operations SOP

_${voice}_

## 1. Purpose
Define how work gets done consistently and reliably.

## 2. Roles & Responsibilities
- Owners: accountable for outcomes
- Operators: execute steps
- Reviewers: ensure quality

## 3. Standard Workflow
1. Intake (request captured)
2. Triage (priority + owner assigned)
3. Execution (steps followed)
4. QA (checks completed)
5. Closeout (notes + learnings)

## 4. Quality Checks
- Verify against acceptance criteria
- Document exceptions
- Log recurring issues

## 5. Metrics
Track:
- Cycle time
- Error rate
- Rework rate
- SLA adherence

## 6. Compliance Notes (${titleCase(state)})
Confirm operational policies align with ${titleCase(state)} rules where applicable.

--- 
_Last updated: ${new Date().toLocaleDateString()}_
`
  }

  // default: employee-handbook
  return `# ${company} — Employee Handbook

_${voice}_

## 1. Welcome & Culture
We’re glad you’re here. This handbook sets expectations and helps you succeed.

## 2. Employment Basics
- Equal opportunity
- At-will employment (where applicable)
- Workplace standards

## 3. Work Hours & Remote Work
- Core working hours
- Time tracking expectations
- Remote work guidelines

## 4. Compensation & Benefits
- Pay schedule
- Benefits overview
- Paid time off (PTO)

## 5. Code of Conduct
- Respectful workplace
- Anti-harassment policy
- Conflicts of interest

## 6. Security & Confidentiality
- Protect company information
- Acceptable use of systems
- Reporting issues

## 7. Discipline & Termination
- Progressive discipline approach
- How investigations work
- Separation steps

## 8. State-Specific Notes (${titleCase(state)})
This draft is a starting point. Review with legal counsel for ${titleCase(state)} compliance.

--- 
_Last updated: ${new Date().toLocaleDateString()}_
`
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null)

    const templateId = String(body?.templateId || "employee-handbook")
    const companyName = body?.companyName ? String(body.companyName) : null
    const state = body?.state ? String(body.state) : null
    const toneRaw = String(body?.tone || "friendly").toLowerCase()
    const tone: Tone = toneRaw === "formal" ? "formal" : toneRaw === "direct" ? "direct" : "friendly"

    const content_md = buildMarkdown({ templateId, companyName, state, tone })
    return NextResponse.json({ content_md }, { status: 200 })
  } catch (e: any) {
    return NextResponse.json(
      { error: "Server error", detail: e?.message || String(e) },
      { status: 500 }
    )
  }
}

