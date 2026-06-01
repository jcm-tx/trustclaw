/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/prefer-regexp-exec */
// src/app/api/twilio/inbound/route.ts
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

interface User {
  id: string
  family_id: string
  name: string
  role: string
  stripe_status: string
  families: { name: string } | null
}

interface OnboardingSession {
  phone_number: string
  step: string
  data: Record<string, string> | null
}

interface Message {
  direction: string
  content: string
  created_at: string
}

interface Event {
  title: string
  event_date: string
  event_time: string | null
  children: { name: string } | null
}

interface FamilyMember {
  name: string
  role: string
  phone_number: string
}

interface Child {
  name: string
  age: number | null
  school: string | null
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const from = formData.get('From') as string
    const body = formData.get('Body') as string
    const channel = from.startsWith('whatsapp:') ? 'whatsapp' : 'sms'
    const phoneNumber = from.replace('whatsapp:', '')

    const { data: userRaw, error: userError } = await supabase
      .from('users')
      .select('*, families(*)')
      .eq('phone_number', phoneNumber)
      .single()

    if (userError && userError.code !== 'PGRST116') {
      console.error('Supabase user lookup error:', userError)
      return twimlResponse('Sorry, something went wrong. Try again in a moment.')
    }

    const user = userRaw as User | null
    const familyId = user?.family_id ?? null
    const userId = user?.id ?? null

    await supabase.from('messages').insert({
      family_id: familyId,
      user_id: userId,
      direction: 'inbound',
      channel,
      content: body,
    })

    // Check if user is still in onboarding even if user record exists
    const { data: activeSession } = await supabase
      .from('dropzone_onboarding')
      .select('*')
      .eq('phone_number', phoneNumber)
      .single()

    const responseText = activeSession
      ? await handleOnboarding(phoneNumber, body, activeSession as OnboardingSession)
      : user
        ? await handleMessageProcessing(user, body)
        : await handleOnboarding(phoneNumber, body, null)

    await supabase.from('messages').insert({
      family_id: familyId,
      user_id: userId,
      direction: 'outbound',
      channel,
      content: responseText,
    })

    return twimlResponse(responseText)

  } catch (err) {
    console.error('Inbound handler error:', err)
    return twimlResponse('Something went wrong on our end. Give it another try.')
  }
}

// ─── Onboarding Flow ─────────────────────────────────────────────────────────

async function handleOnboarding(
  phoneNumber: string,
  body: string,
  session: OnboardingSession | null
): Promise<string> {
  if (!session) {
    await supabase.from('dropzone_onboarding').insert({
      phone_number: phoneNumber,
      step: 'awaiting_name',
      data: {},
    })
    return "Hey! Welcome to Covered 👋 I'm Mary — I help families stay on top of schedules, pickups, and all the moving pieces. What's your name?"
  }

  switch (session.step) {
    case 'awaiting_name': {
      const name = body.trim()
      await supabase
        .from('dropzone_onboarding')
        .update({ step: 'awaiting_kids', data: { name } })
        .eq('phone_number', phoneNumber)
      return `Nice to meet you, ${name}! How many kids are we coordinating for, and what are their names and ages?`
    }

    case 'awaiting_kids': {
      const sessionData = session.data ?? {}
      const name = sessionData.name ?? 'there'
      const firstName = name.split(' ')[0] ?? name

      const { data: familyRaw } = await supabase
        .from('families')
        .insert({ name: `The ${firstName} Family`, tier: 'solo' })
        .select()
        .single()

      const family = familyRaw as { id: string } | null
      if (!family) return 'Something went wrong setting up your family. Try again.'

      const { data: newUserRaw } = await supabase
        .from('users')
        .insert({
          phone_number: phoneNumber,
          name,
          family_id: family.id,
          role: 'parent',
          trial_start: new Date().toISOString(),
          stripe_status: 'trial',
        })
        .select()
        .single()

      const newUser = newUserRaw as { id: string } | null
      const kidsText = body.trim()

      await supabase
        .from('dropzone_onboarding')
        .update({
          step: 'awaiting_village',
          data: {
            ...sessionData,
            family_id: family.id,
            user_id: newUser?.id ?? '',
            kids_raw: kidsText,
          },
        })
        .eq('phone_number', phoneNumber)

      const kids = parseKids(kidsText, family.id)
      if (kids.length > 0) {
        await supabase.from('children').insert(kids)
      }

      return `Perfect. Is there anyone else in your village I should reach about the kids? A co-parent, partner, grandparent, nanny — anyone who helps. If yes, what's their name and phone number? If not, just say "no".`
    }

    case 'awaiting_village': {
      const sessionData = session.data ?? {}
      const lowerBody = body.trim().toLowerCase()

      const isDeclining =
        lowerBody === 'no' ||
        lowerBody === 'nope' ||
        lowerBody === 'none' ||
        lowerBody === 'skip' ||
        lowerBody.startsWith('no ') ||
        lowerBody.includes('not adding') ||
        lowerBody.includes('just me') ||
        lowerBody.includes('not now') ||
        lowerBody.includes('maybe later') ||
        lowerBody.includes('later') ||
        lowerBody.includes('no one') ||
        lowerBody.includes('nobody') ||
        lowerBody.includes('not yet')

      await supabase
        .from('dropzone_onboarding')
        .update({
          step: 'awaiting_timezone',
          data: isDeclining
            ? { ...sessionData, village_declined: 'true' }
            : { ...sessionData, village_raw: body.trim() },
        })
        .eq('phone_number', phoneNumber)

      return "Almost done! What time zone are you in so I can get your reminders right?"
    }

    case 'awaiting_timezone': {
      const sessionData = session.data ?? {}
      const timezone = resolveTimezone(body.trim())

      if (sessionData.user_id) {
        await supabase
          .from('users')
          .update({ timezone })
          .eq('id', sessionData.user_id)
      }

      await supabase
        .from('dropzone_onboarding')
        .delete()
        .eq('phone_number', phoneNumber)

      return "You're all set! Your 7-day free trial starts now — no credit card needed. What's the first thing on your schedule? Just text me anything — a pickup, a school event, whatever's coming up."
    }

    default:
      return "Hey! Welcome to Covered 👋 I'm Mary. What's your name?"
  }
}

// ─── Timezone Resolution ──────────────────────────────────────────────────────

function resolveTimezone(input: string): string {
  const lower = input.toLowerCase()
  const map: Record<string, string> = {
    'eastern': 'America/New_York',
    'est': 'America/New_York',
    'et': 'America/New_York',
    'new york': 'America/New_York',
    'florida': 'America/New_York',
    'georgia': 'America/New_York',
    'central': 'America/Chicago',
    'cst': 'America/Chicago',
    'ct': 'America/Chicago',
    'chicago': 'America/Chicago',
    'texas': 'America/Chicago',
    'illinois': 'America/Chicago',
    'minnesota': 'America/Chicago',
    'mountain': 'America/Denver',
    'mst': 'America/Denver',
    'mt': 'America/Denver',
    'denver': 'America/Denver',
    'colorado': 'America/Denver',
    'utah': 'America/Denver',
    'pacific': 'America/Los_Angeles',
    'pst': 'America/Los_Angeles',
    'pt': 'America/Los_Angeles',
    'los angeles': 'America/Los_Angeles',
    'california': 'America/Los_Angeles',
    'washington': 'America/Los_Angeles',
    'oregon': 'America/Los_Angeles',
    'alaska': 'America/Anchorage',
    'hawaii': 'Pacific/Honolulu',
  }

  for (const [key, value] of Object.entries(map)) {
    if (lower.includes(key)) return value
  }

  return 'America/Chicago'
}

// ─── Message Processing Flow ──────────────────────────────────────────────────

async function handleMessageProcessing(
  user: User,
  body: string
): Promise<string> {
  const familyId = user.family_id
  const today = new Date().toISOString().split('T')[0]!
  const in14Days = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]!

  const [
    { data: recentMessagesRaw },
    { data: upcomingEventsRaw },
    { data: familyMembersRaw },
    { data: childrenRaw },
  ] = await Promise.all([
    supabase
      .from('messages')
      .select('direction, content, created_at')
      .eq('family_id', familyId)
      .order('created_at', { ascending: false })
      .limit(5),
    supabase
      .from('events')
      .select('title, event_date, event_time, children(name)')
      .eq('family_id', familyId)
      .gte('event_date', today)
      .lte('event_date', in14Days)
      .order('event_date', { ascending: true }),
    supabase
      .from('users')
      .select('name, role, phone_number')
      .eq('family_id', familyId),
    supabase
      .from('children')
      .select('name, age, school')
      .eq('family_id', familyId),
  ])

  const recentMessages = (recentMessagesRaw ?? []) as Message[]
  const upcomingEvents = (upcomingEventsRaw ?? []) as unknown as Event[]
  const familyMembers = (familyMembersRaw ?? []) as FamilyMember[]
  const children = (childrenRaw ?? []) as Child[]

  return callClaude({ user, body, recentMessages, upcomingEvents, familyMembers, children })
}

// ─── Claude Simple Helper ─────────────────────────────────────────────────────

async function callClaudeSimple(prompt: string): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 10,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  const result = await response.json() as { content?: Array<{ text?: string }> }
  return result.content?.[0]?.text ?? 'yes'
}

// ─── Claude Integration ───────────────────────────────────────────────────────

async function callClaude({
  user,
  body,
  recentMessages,
  upcomingEvents,
  familyMembers,
  children,
}: {
  user: User
  body: string
  recentMessages: Message[]
  upcomingEvents: Event[]
  familyMembers: FamilyMember[]
  children: Child[]
}): Promise<string> {
  const systemPrompt = `You are Mary, the warm and reliable coordinator behind Covered — a family logistics service. You have a perfect memory of every family you work with. You are specific, never generic. You always reference the actual names, dates, and details from the family context provided. You are conversational and human — never robotic, never use bullet points in messages, never say "I have logged your request", never use markdown formatting, asterisks, or bold text. You speak the way a brilliant, organized friend would speak over text. Keep responses concise — this is a text message, not an email. Maximum 3 sentences unless a summary is explicitly requested. Do not include intent classifications in your response.`

  const familyContext = [
    `Family: ${user.families?.name ?? 'Unknown'}`,
    `Parent: ${user.name}`,
    `Children: ${children.map(c => `${c.name} (${c.age ?? 'age unknown'})`).join(', ') || 'None on file'}`,
    `Family members: ${familyMembers.map(m => `${m.name} (${m.role})`).join(', ') || 'Just you'}`,
    `Upcoming events: ${upcomingEvents.length > 0 ? upcomingEvents.map(e => `${e.title} on ${e.event_date}${e.event_time ? ' at ' + e.event_time : ''}`).join(', ') : 'None'}`,
    `Recent messages:\n${recentMessages.map(m => `[${m.direction}] ${m.content}`).join('\n') || 'None'}`,
  ].join('\n')

  const now = new Date()
  const todayStr = now.toLocaleDateString('en-US', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric',
    timeZone: 'America/Chicago'
})
  const todayISO = now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })
  const tomorrowISO = new Date(now.getTime() + 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })
  const nextWeekISO = new Date(now.getTime() + 7 * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })
  
  const userMessage = `Today is ${todayStr} (${todayISO}). Tomorrow is ${tomorrowISO}. Next week starts around ${nextWeekISO}.\n\nClassify the intent internally (ADD_EVENT, QUERY, COORDINATE, FORWARD, CONFIRM, OTHER) but do NOT include the intent in your response. Just respond naturally. If ADD_EVENT, also return event details wrapped in <event_data>...</event_data> tags as JSON with fields: title, event_date (YYYY-MM-DD), event_time (HH:MM or null), child_name (or null), notes (or null).`

  const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  })

  const result = await apiResponse.json() as { content?: Array<{ text?: string }> }
  const fullText = result.content?.[0]?.text ?? "Got it — I'll take care of that."

  if (fullText.includes('<event_data>')) {
    await extractAndStoreEvent(fullText, user)
  }

  return fullText
    .replace(/<event_data>[\s\S]*?<\/event_data>/g, '')
    .replace(/\*Intent:[\s\S]*?\*/g, '')
    .replace(/Intent:\s*\w+\n?/g, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .trim()
}

// ─── Event Extraction ─────────────────────────────────────────────────────────

async function extractAndStoreEvent(claudeText: string, user: User): Promise<void> {
  try {
    const match = claudeText.match(/<event_data>([\s\S]*?)<\/event_data>/)
    if (!match?.[1]) return

    const eventData = JSON.parse(match[1]) as {
      title: string
      event_date: string
      event_time: string | null
      child_name: string | null
      notes: string | null
    }

    const { title, event_date, event_time, child_name, notes } = eventData

    let childId: string | null = null
    if (child_name) {
      const { data: childRaw } = await supabase
        .from('children')
        .select('id')
        .eq('family_id', user.family_id)
        .ilike('name', child_name)
        .single()
      const child = childRaw as { id: string } | null
      childId = child?.id ?? null
    }

    await supabase.from('events').insert({
      family_id: user.family_id,
      child_id: childId,
      title,
      event_date,
      event_time: event_time ?? null,
      notes: notes ?? null,
      confirmed: false,
    })
  } catch (err) {
    console.error('Event extraction error:', err)
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function twimlResponse(message: string): NextResponse {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${escapeXml(message)}</Message>
</Response>`

  return new NextResponse(twiml, {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
  })
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function parseKids(text: string, familyId: string): Array<{ family_id: string; name: string; age: number | null }> {
  const kids: Array<{ family_id: string; name: string; age: number | null }> = []
  const pattern = /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s*[\(\s]?(\d+)[\)\s]?/g
  let match

  while ((match = pattern.exec(text)) !== null) {
    const name = match[1]!.trim()
    const age = parseInt(match[2]!)
    if (name.length > 1) {
      kids.push({ family_id: familyId, name, age })
    }
  }

  if (kids.length === 0) {
    kids.push({ family_id: familyId, name: text.trim(), age: null })
  }

  return kids
}

// Keep callClaudeSimple available but suppress unused warning
void callClaudeSimple
