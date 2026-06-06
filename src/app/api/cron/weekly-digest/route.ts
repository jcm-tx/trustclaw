/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
// src/app/api/cron/weekly-digest/route.ts
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  try {
    const now = new Date()
    const todayISO = now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })
    const lastWeekISO = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      .toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })
    const nextWeekISO = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
      .toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })

    const { data: families, error } = await supabase
      .from('families')
      .select('id, name')

    if (error || !families) {
      console.error('Error fetching families:', error)
      return new NextResponse('Error fetching families', { status: 500 })
    }

    let digestsSent = 0

    for (const family of families) {
      try {
        const { data: members } = await supabase
          .from('users')
          .select('id, name, phone_number, stripe_status')
          .eq('family_id', family.id)
          .in('stripe_status', ['trial', 'active'])

        if (!members || members.length === 0) continue

        // Get last week's events
        const { data: pastEvents } = await supabase
          .from('events')
          .select('title, event_date, event_time, children(name)')
          .eq('family_id', family.id)
          .gte('event_date', lastWeekISO)
          .lt('event_date', todayISO)
          .order('event_date', { ascending: true })

        // Get next week's events
        const { data: upcomingEvents } = await supabase
          .from('events')
          .select('title, event_date, event_time, children(name)')
          .eq('family_id', family.id)
          .gte('event_date', todayISO)
          .lte('event_date', nextWeekISO)
          .order('event_date', { ascending: true })

        // Skip if nothing happened and nothing coming up
        if (
          (!pastEvents || pastEvents.length === 0) &&
          (!upcomingEvents || upcomingEvents.length === 0)
        ) continue

        const { data: children } = await supabase
          .from('children')
          .select('name, type')
          .eq('family_id', family.id)

        const digest = await generateDigest({
          familyName: family.name,
          primaryParentName: members[0]!.name,
          pastEvents: pastEvents ?? [],
          upcomingEvents: upcomingEvents ?? [],
          children: children ?? [],
          lastWeekISO,
          todayISO,
          nextWeekISO,
        })

        for (const member of members) {
          await sendSMS(member.phone_number, digest)
          digestsSent++
        }

      } catch (err) {
        console.error(`Error processing family ${family.id}:`, err)
      }
    }

    return new NextResponse(`Weekly digests sent: ${digestsSent}`, { status: 200 })

  } catch (err) {
    console.error('Weekly digest cron error:', err)
    return new NextResponse('Cron job failed', { status: 500 })
  }
}

// ─── Digest Generation ────────────────────────────────────────────────────────

async function generateDigest({
  familyName,
  primaryParentName,
  pastEvents,
  upcomingEvents,
  children,
  lastWeekISO,
  todayISO,
  nextWeekISO,
}: {
  familyName: string
  primaryParentName: string
  pastEvents: any[]
  upcomingEvents: any[]
  children: any[]
  lastWeekISO: string
  todayISO: string
  nextWeekISO: string
}): Promise<string> {

  const formatEvent = (e: any) => {
    const childRaw = Array.isArray(e.children) ? e.children[0] : e.children
    return `${e.title}${e.event_time ? ' at ' + e.event_time : ''}${childRaw?.name ? ' for ' + childRaw.name : ''} (${e.event_date})`
  }

  const pastList = pastEvents.length > 0
    ? pastEvents.map(formatEvent).join(', ')
    : 'nothing scheduled'

  const upcomingList = upcomingEvents.length > 0
    ? upcomingEvents.map(formatEvent).join(', ')
    : 'nothing scheduled yet'

  const childrenList = children.map((c: any) => c.name).join(', ')

  const prompt = `You are Mary, a warm AI family coordinator. Write a brief, friendly weekly digest text message for ${primaryParentName} from ${familyName}.

Children/dependents: ${childrenList}
Last week (${lastWeekISO} to ${todayISO}): ${pastList}
Coming week (${todayISO} to ${nextWeekISO}): ${upcomingList}

Write it like a friend giving a quick weekly summary — casual, warm, specific. 3-4 sentences max. No bullet points, no markdown, no asterisks. Start with "Hey ${primaryParentName}!" End with something encouraging or warm. If next week looks clear, say so. If it's busy, acknowledge it.`

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  const result = await response.json() as { content?: Array<{ text?: string }> }
  return result.content?.[0]?.text ?? `Hey ${primaryParentName}! Here's your weekly recap from Mary.`
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
