// src/app/api/cron/morning-briefing/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(req: NextRequest) {
  // Verify cron secret
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  try {
    const now = new Date()
    const todayISO = now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })
    const tomorrowISO = new Date(now.getTime() + 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })

    // Get all active families with their members
    const { data: families, error: familiesError } = await supabase
      .from('families')
      .select('id, name')

    if (familiesError || !families) {
      console.error('Error fetching families:', familiesError)
      return new NextResponse('Error fetching families', { status: 500 })
    }

    let briefingsSent = 0

    for (const family of families) {
      try {
        // Get family members who are active (trial or paying)
        const { data: members } = await supabase
          .from('users')
          .select('id, name, phone_number, timezone, stripe_status')
          .eq('family_id', family.id)
          .in('stripe_status', ['trial', 'active'])

        if (!members || members.length === 0) continue

        // Get today's and tomorrow's events for this family
        const { data: todayEvents } = await supabase
          .from('events')
          .select('title, event_date, event_time, children(name), assigned_user:assigned_to(name)')
          .eq('family_id', family.id)
          .eq('event_date', todayISO)
          .order('event_time', { ascending: true })

        const { data: tomorrowEvents } = await supabase
          .from('events')
          .select('title, event_date, event_time, children(name), assigned_user:assigned_to(name)')
          .eq('family_id', family.id)
          .eq('event_date', tomorrowISO)
          .order('event_time', { ascending: true })

        // Skip if nothing happening today or tomorrow
        if (
          (!todayEvents || todayEvents.length === 0) &&
          (!tomorrowEvents || tomorrowEvents.length === 0)
        ) continue

        // Get children for context
        const { data: children } = await supabase
          .from('children')
          .select('name, age')
          .eq('family_id', family.id)

        // Generate briefing via Claude
        const briefing = await generateBriefing({
          familyName: family.name,
          primaryParentName: members[0]!.name,
          todayEvents: todayEvents ?? [],
          tomorrowEvents: tomorrowEvents ?? [],
          children: children ?? [],
          todayISO,
          tomorrowISO,
        })

        // Send to all active family members
        for (const member of members) {
          await sendSMS(member.phone_number, briefing)
          briefingsSent++
        }

      } catch (err) {
        console.error(`Error processing family ${family.id}:`, err)
      }
    }

    return new NextResponse(`Morning briefings sent: ${briefingsSent}`, { status: 200 })

  } catch (err) {
    console.error('Morning briefing cron error:', err)
    return new NextResponse('Cron job failed', { status: 500 })
  }
}

// ─── Briefing Generation ──────────────────────────────────────────────────────

async function generateBriefing({
  familyName,
  primaryParentName,
  todayEvents,
  tomorrowEvents,
  children,
  todayISO,
  tomorrowISO,
}: {
  familyName: string
  primaryParentName: string
  todayEvents: any[]
  tomorrowEvents: any[]
  children: any[]
  todayISO: string
  tomorrowISO: string
}): Promise<string> {
  const todayList = todayEvents.length > 0
    ? todayEvents.map(e =>
        `${e.title}${e.event_time ? ' at ' + e.event_time : ''}${e.children?.name ? ' for ' + e.children.name : ''}${e.assigned_user?.name ? ' (assigned to ' + e.assigned_user.name + ')' : ''}`
      ).join(', ')
    : 'nothing scheduled'

  const tomorrowList = tomorrowEvents.length > 0
    ? tomorrowEvents.map(e =>
        `${e.title}${e.event_time ? ' at ' + e.event_time : ''}${e.children?.name ? ' for ' + e.children.name : ''}${e.assigned_user?.name ? ' (assigned to ' + e.assigned_user.name + ')' : ''}`
      ).join(', ')
    : 'nothing scheduled'

  const childrenList = children.map(c => c.name).join(', ')

  const prompt = `You are Mary, a warm family logistics coordinator. Write a brief, friendly morning text message (2-3 sentences max) for ${primaryParentName} from ${familyName}. 

Children: ${childrenList}
Today (${todayISO}): ${todayList}
Tomorrow (${tomorrowISO}): ${tomorrowList}

Write it like a friend giving a quick heads up — casual, specific, no bullet points, no markdown, no asterisks. Start with "Morning" not "Good morning". End with something brief and warm. If today is clear mention it. If tomorrow has something coming up give them a heads up.`

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  const result = await response.json() as { content?: Array<{ text?: string }> }
  return result.content?.[0]?.text ?? `Morning ${primaryParentName}! Here's what's on deck today.`
}

// ─── SMS Helper ───────────────────────────────────────────────────────────────

async function sendSMS(to: string, message: string): Promise<void> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID
  const authToken = process.env.TWILIO_AUTH_TOKEN
  const from = process.env.TWILIO_PHONE_NUMBER

  if (!accountSid || !authToken || !from) {
    console.error('Twilio credentials missing')
    return
  }

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: from, Body: message }),
    }
  )

  if (!response.ok) {
    console.error('Twilio SMS failed:', await response.text())
  }
}
