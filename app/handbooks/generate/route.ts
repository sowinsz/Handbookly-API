import { NextResponse } from "next/server"
import OpenAI from "openai"
import { createClient } from "@supabase/supabase-js"

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
})

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
}

export async function OPTIONS() {
  return new Response(null, { headers: corsHeaders })
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const {
      handbookId,
      templateId,
      companyName,
      state,
      tone,
    } = body

    if (!handbookId) {
      return NextResponse.json(
        { error: "Missing handbookId" },
        { status: 400, headers: corsHeaders }
      )
    }

    const prompt = `
You are an HR compliance expert.

Write a full employee handbook in Markdown format.

Template: ${templateId || "Employee Handbook"}
Company: ${companyName || "The Company"}
State: ${state || "United States"}
Tone: ${tone || "Friendly"}

Include:
- Welcome
- Employment policies
- Code of conduct
- Benefits
- Time off
- Legal disclaimers
`

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You write professional employee handbooks." },
        { role: "user", content: prompt },
      ],
      temperature: 0.4,
    })

    const content_md =
      completion.choices[0]?.message?.content || ""

    if (!content_md) {
      return NextResponse.json(
        { error: "AI returned empty content" },
        { status: 500, headers: corsHeaders }
      )
    }

    const { error } = await supabase
      .from("handbooks")
      .update({
        content_md,
        template_id: templateId || null,
      })
      .eq("id", handbookId)

    if (error) {
      return NextResponse.json(
        { error: error.message },
        { status: 500, headers: corsHeaders }
      )
    }

    return NextResponse.json(
      { content_md },
      { headers: corsHeaders }
    )
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "Unexpected error" },
      { status: 500, headers: corsHeaders }
    )
  }
}

