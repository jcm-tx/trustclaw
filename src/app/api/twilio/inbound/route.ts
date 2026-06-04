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
  assigned_user: { name: string } | null
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
  type: string | null
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
      .maybeSingle()

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
    return "Hey! Welcome to Life. Covered. 👋 I'm Mary, an AI coordinator — I help families stay on top of schedules, pickups, and all the moving pieces. What's your name?"
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

      const { kids, elderly } = await parseKidsAndElderly(kidsText, family.id)
      if (kids.length > 0) {
        await supabase.from('children').insert(kids)
      }
      if (elderly.length > 0) {
        await supabase.from('children').insert(elderly)
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

      // Save village member if one was provided
      if (sessionData.village_raw && sessionData.family_id) {
        const villageText = sessionData.village_raw
        const parsed = parseVillageMember(villageText)
        if (parsed) {
          await supabase.from('users').insert({
            phone_number: parsed.phone,
            name: parsed.name,
            family_id: sessionData.family_id,
            role: 'village',
            stripe_status: 'village',
          })
        }
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
      .select('title, event_date, event_time, children(name), assigned_user:assigned_to(name)')
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
      .select('name, age, school, type')
      .eq('family_id', familyId),
  ])

  const recentMessages = (recentMessagesRaw ?? []) as Message[]
  const upcomingEvents = (upcomingEventsRaw ?? []) as unknown as Event[]
  const familyMembers = (familyMembersRaw ?? []) as FamilyMember[]
  const children = (childrenRaw ?? []) as Child[]

  return callClaude({ user, body, recentMessages, upcomingEvents, familyMembers, children })
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
  const systemPrompt = `You are Mary, the warm and reliable coordinator behind Covered — a family logistics service. You have a perfect memory of every family you work with. You are specific, never generic. You always reference the actual names, dates, and details from the family context provided. You are conversational and human — never robotic, never use bullet points in messages, never say "I have logged your request", never use markdown formatting, asterisks, or bold text. You speak the way a brilliant, organized friend would speak over text. Keep responses concise — this is a text message, not an email. Maximum 3 sentences unless a summary is explicitly requested. Do not include intent classifications in your response. IMPORTANT: Reminders are automatic — when an event is saved, reminders fire automatically 2 hours before and 30 minutes before. Never ask the user when they want a reminder or for which event. Just confirm the event is saved and tell them reminders will go out automatically. Never ask clarifying questions about reminders. The family context may include elderly dependents — treat them with the same care as children but use age-appropriate language (appointments, rides, medications) rather than school/activity language.`

  // Calculate today's date in user's timezone for accurate date handling
  const now = new Date()
  const todayISO = now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })
  const todayStr = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'America/Chicago',
  })
  const tomorrowISO = new Date(now.getTime() + 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })
  const nextWeekISO = new Date(now.getTime() + 7 * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })

  const actualKids = children.filter(c => c.type !== 'elderly')
  const elderlyDependents = children.filter(c => c.type === 'elderly')

  const familyContext = [
    `Family: ${user.families?.name ?? 'Unknown'}`,
    `Parent: ${user.name}`,
    `Children: ${actualKids.map(c => `${c.name} (${c.age ?? 'age unknown'})`).join(', ') || 'None on file'}`,
    elderlyDependents.length > 0 ? `Elderly dependents: ${elderlyDependents.map(c => `${c.name} (${c.age ?? 'age unknown'})`).join(', ')}` : '',
    `Family members: ${familyMembers.map(m => `${m.name} (${m.role})`).join(', ') || 'Just you'}`,
    `Upcoming events: ${upcomingEvents.length > 0 ? upcomingEvents.map(e => `${e.title} on ${e.event_date}${e.event_time ? ' at ' + e.event_time : ''}${e.assigned_user ? ' (assigned to ' + e.assigned_user.name + ')' : ''}`).join(', ') : 'None'}`,
    `Recent messages:\n${recentMessages.map(m => `[${m.direction}] ${m.content}`).join('\n') || 'None'}`,
  ].filter(Boolean).join('\n')

  const userMessage = `Today is ${todayStr} (${todayISO}). Tomorrow is ${tomorrowISO}. Next week starts around ${nextWeekISO}.

${familyContext}

Incoming message: "${body}"

Classify the intent internally (ADD_EVENT, QUERY, COORDINATE, FORWARD, CONFIRM, OTHER) but do NOT include the intent in your response. Just respond naturally.

IMPORTANT: If the message contains ANY scheduling information, you MUST return a separate <event_data>...</event_data> block for EACH event mentioned. Use the exact ISO dates provided above. Example for multiple events:
<event_data>{"title": "Football", "event_date": "${todayISO}", "event_time": "18:00", "child_name": "JM", "notes": null}</event_data>
<event_data>{"title": "Softball", "event_date": "${todayISO}", "event_time": "16:00", "child_name": "Estela", "notes": null}</event_data>

The event_data blocks will be stripped before sending to the user so always include one per event.`

  const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
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
    // Find ALL event_data blocks — Claude may return multiple for multi-event messages
    const matches = [...claudeText.matchAll(/<event_data>([\s\S]*?)<\/event_data>/g)]
    if (matches.length === 0) return

    for (const match of matches) {
      if (!match[1]) continue

      try {
        const eventData = JSON.parse(match[1]) as {
          title: string
          event_date: string
          event_time: string | null
          child_name: string | null
          notes: string | null
        }

        const { title, event_date, event_time, child_name, notes } = eventData

        if (!event_date || !/^\d{4}-\d{2}-\d{2}$/.test(event_date)) {
          console.error('Invalid event_date format:', event_date)
          continue
        }

        let childId: string | null = null
        if (child_name) {
          const { data: childRaw } = await supabase
            .from('children')
            .select('id')
            .eq('family_id', user.family_id)
            .ilike('name', `%${child_name}%`)
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
      } catch (innerErr) {
        console.error('Error parsing individual event_data block:', innerErr)
      }
    }
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

async function parseKidsAndElderly(text: string, familyId: string): Promise<{
  kids: Array<{ family_id: string; name: string; age: number | null; type: string }>
  elderly: Array<{ family_id: string; name: string; age: number | null; type: string }>
}> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Extract all people from this text and classify them as either "child" (under 18) or "elderly" (adult dependent like grandparent, elderly relative). Return ONLY valid JSON with no other text.

Text: "${text}"

Return this exact format:
{"people": [{"name": "John Mark", "age": 13, "type": "child"}, {"name": "Grandpa", "age": 82, "type": "elderly"}]}

Rules:
- Use the exact name as given (e.g. "John Mark" not "John")
- If no age given, use null
- Grandpa/Grandma/Nana/Papa etc are always "elderly"
- Anyone under 18 or described as a kid/child is "child"
- Return empty array if no people found: {"people": []}`
      }],
    }),
  })

  const result = await response.json() as { content?: Array<{ text?: string }> }
  const text2 = result.content?.[0]?.text ?? '{"people": []}'

  try {
    const parsed = JSON.parse(text2) as { people: Array<{ name: string; age: number | null; type: string }> }
    const kids = parsed.people
      .filter(p => p.type === 'child')
      .map(p => ({ family_id: familyId, name: p.name, age: p.age, type: 'child' }))
    const elderly = parsed.people
      .filter(p => p.type === 'elderly')
      .map(p => ({ family_id: familyId, name: p.name, age: p.age, type: 'elderly' }))
    return { kids, elderly }
  } catch {
    return { kids: [], elderly: [] }
  }
}

function parseVillageMember(text: string): { name: string; phone: string } | null {
  // Extract phone number — handles formats like 469-826-8927, (469) 826-8927, 4698268927
  const phoneMatch = text.match(/(\+?1?\s?)?(\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4})/)
  if (!phoneMatch) return null

  // Clean phone number to E.164 format
  const rawPhone = phoneMatch[0].replace(/[^\d]/g, '')
  const phone = rawPhone.length === 10 ? `+1${rawPhone}` : `+${rawPhone}`

  // Extract name — everything before the phone number, cleaned up
  const nameSection = text.slice(0, text.indexOf(phoneMatch[0])).trim()
  const name = nameSection
    .replace(/,\s*$/, '')
    .replace(/^(his|her|my|the|is|at|call|contact|number)\s+/i, '')
    .trim()

  if (!name || name.length < 2) return null

  return { name, phone }
}
