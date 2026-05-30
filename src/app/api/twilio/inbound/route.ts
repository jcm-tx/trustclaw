// src/app/api/twilio/inbound/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
 
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)
 
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
 
    const from = formData.get('From') as string
    const body = formData.get('Body') as string
    const channel = from.startsWith('whatsapp:') ? 'whatsapp' : 'sms'
 
    const phoneNumber = from.replace('whatsapp:', '')
 
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('*, families(*)')
      .eq('phone_number', phoneNumber)
      .single()
 
    if (userError && userError.code !== 'PGRST116') {
      console.error('Supabase user lookup error:', userError)
      return twimlResponse('Sorry, something went wrong. Try again in a moment.')
    }
 
    const familyId = user?.family_id ?? null
    const userId = user?.id ?? null
 
    await supabase.from('messages').insert({
      family_id: familyId,
      user_id: userId,
      direction: 'inbound',
      channel,
      content: body,
    })
 
    let responseText: string
 
    if (!user) {
      responseText = await handleOnboarding(phoneNumber, body)
    } else {
      responseText = await handleMessageProcessing(user, body, channel)
    }
 
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
  body: string
): Promise<string> {
  const { data: session } = await supabase
    .from('onboarding_sessions')
    .select('*')
    .eq('phone_number', phoneNumber)
    .single()
 
  if (!session) {
    await supabase.from('onboarding_sessions').insert({
      phone_number: phoneNumber,
      step: 'awaiting_name',
    })
 
    return "Hey! Welcome to DropZone 👋 I'm Tony — I help families stay on top of schedules, pickups, and all the moving pieces. What's your name?"
  }
 
  switch (session.step) {
    case 'awaiting_name': {
      const name = body.trim()
      await supabase
        .from('onboarding_sessions')
        .update({ step: 'awaiting_kids', data: { name } })
        .eq('phone_number', phoneNumber)
 
      return `Nice to meet you, ${name}! How many kids are we coordinating for, and what are their names and ages?`
    }
 
    case 'awaiting_kids': {
      const sessionData = session.data ?? {}
      const name = sessionData.name
 
      const { data: family } = await supabase
        .from('families')
        .insert({ name: `The ${name.split(' ')[0]} Family`, tier: 'solo' })
        .select()
        .single()
 
      const { data: newUser } = await supabase
        .from('users')
        .insert({
          phone_number: phoneNumber,
          name,
          family_id: family!.id,
          role: 'parent',
          trial_start: new Date().toISOString(),
          stripe_status: 'trial',
        })
        .select()
        .single()
 
      const kidsText = body.trim()
      await supabase
        .from('onboarding_sessions')
        .update({
          step: 'awaiting_village',
          data: { ...sessionData, family_id: family!.id, user_id: newUser!.id, kids_raw: kidsText },
        })
        .eq('phone_number', phoneNumber)
 
      await supabase
        .from('children')
        .insert(parseKids(kidsText, family!.id))
 
      return `Perfect. Is there anyone else in your village I should be able to reach about the kids? That could be a co-parent, partner, grandparent, nanny — anyone who helps. If yes, what's their name and phone number? If not, just say "no".`
    }
 
    case 'awaiting_village': {
      const lowerBody = body.trim().toLowerCase()
 
      await supabase
        .from('onboarding_sessions')
        .delete()
        .eq('phone_number', phoneNumber)
 
      if (lowerBody === 'no' || lowerBody === 'nope' || lowerBody === 'just me') {
        return "You're all set! Your 7-day free trial starts now — no credit card needed yet. Just text me anything on the schedule — a pickup time, a school event, whatever's coming up. I'll take it from there."
      }
 
      return "Got it — I'll reach out to them to get connected. Your 7-day free trial starts now. Just text me anything on the schedule and I'll take it from there."
    }
 
    default:
      return "Hey! Welcome to DropZone 👋 I'm Tony. What's your name?"
  }
}
 
// ─── Message Processing Flow ──────────────────────────────────────────────────
 
async function handleMessageProcessing(
  user: any,
  body: string,
  channel: string
): Promise<string> {
  const familyId = user.family_id
 
  const { data: recentMessages } = await supabase
    .from('messages')
    .select('direction, content, created_at')
    .eq('family_id', familyId)
    .order('created_at', { ascending: false })
    .limit(10)
 
  const today = new Date().toISOString().split('T')[0]
  const in14Days = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0]
 
  const { data: upcomingEvents } = await supabase
    .from('events')
    .select('*, children(name)')
    .eq('family_id', familyId)
    .gte('event_date', today)
    .lte('event_date', in14Days)
    .order('event_date', { ascending: true })
 
  const { data: familyMembers } = await supabase
    .from('users')
    .select('name, role, phone_number')
    .eq('family_id', familyId)
 
  const { data: children } = await supabase
    .from('children')
    .select('name, age, school')
    .eq('family_id', familyId)
 
  const response = await callClaude({
    user,
    body,
    recentMessages: recentMessages ?? [],
    upcomingEvents: upcomingEvents ?? [],
    familyMembers: familyMembers ?? [],
    children: children ?? [],
  })
 
  return response
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
  user: any
  body: string
  recentMessages: any[]
  upcomingEvents: any[]
  familyMembers: any[]
  children: any[]
}): Promise<string> {
  const systemPrompt = `You are Tony, the warm and reliable coordinator behind DropZone — a family logistics service. You have a perfect memory of every family you work with. You are specific, never generic. You always reference the actual names, dates, and details from the family context provided. You are conversational and human — never robotic, never use bullet points in messages, never say "I have logged your request." You speak the way a brilliant, organized friend would speak over text. Keep responses concise — this is a text message, not an email. Maximum 3 sentences unless a summary is explicitly requested.`
 
  const familyContext = `
Family: ${user.families?.name ?? 'Unknown'}
Parent: ${user.name}
Children: ${children.map((c: any) => `${c.name} (${c.age}, ${c.school})`).join(', ') || 'None on file'}
Family members: ${familyMembers.map((m: any) => `${m.name} (${m.role})`).join(', ')}
Upcoming events: ${upcomingEvents.length > 0 ? upcomingEvents.map((e: any) => `${e.title} on ${e.event_date}${e.event_time ? ' at ' + e.event_time : ''}`).join(', ') : 'None'}
Recent messages: ${recentMessages.map((m: any) => `[${m.direction}] ${m.content}`).join('\n')}
  `.trim()
 
  const userMessage = `${familyContext}\n\nIncoming message: "${body}"\n\nClassify the intent (ADD_EVENT, QUERY, COORDINATE, FORWARD, CONFIRM, OTHER) and respond appropriately. If ADD_EVENT, also return a JSON block with event details wrapped in <event_data>...</event_data> tags.`
 
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
 
  const result = await apiResponse.json()
  const fullText: string = result.content?.[0]?.text ?? "Got it — I'll take care of that."
 
  if (fullText.includes('<event_data>')) {
    await extractAndStoreEvent(fullText, user)
  }
 
  return fullText.replace(/<event_data>[\s\S]*?<\/event_data>/g, '').trim()
}
 
// ─── Event Extraction ─────────────────────────────────────────────────────────
 
async function extractAndStoreEvent(claudeText: string, user: any) {
  try {
    const match = claudeText.match(/<event_data>([\s\S]*?)<\/event_data>/)
    if (!match) return
 
    const eventData = JSON.parse(match[1]!)
    const { title, event_date, event_time, child_name, notes } = eventData
 
    let childId = null
    if (child_name) {
      const { data: child } = await supabase
        .from('children')
        .select('id')
        .eq('family_id', user.family_id)
        .ilike('name', child_name)
        .single()
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
 
function parseKids(text: string, familyId: string): any[] {
  // Handles formats like "Marco (8) and Lily (5)" or "two kids, Jake 10 and Emma 7"
  const kids: any[] = []
  const agePattern = /([A-Z][a-z]+)\s*[\(\s](\d+)[\)\s]?/g
  let match
 
  while ((match = agePattern.exec(text)) !== null) {
    kids.push({
      family_id: familyId,
      name: match[1]!,
      age: parseInt(match[2]!),
    })
  }
 
  // Fallback: if no pattern matched, store the raw text as one child entry
  if (kids.length === 0) {
    kids.push({
      family_id: familyId,
      name: text.trim(),
      age: null,
    })
  }
 
  return kids
}
 
