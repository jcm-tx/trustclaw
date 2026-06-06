/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/prefer-regexp-exec */
/* eslint-disable @typescript-eslint/no-explicit-any */
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

    // Handle opt-out/opt-in/help keywords before anything else
    const upperBody = body.trim().toUpperCase()

    if (upperBody === 'STOP' || upperBody === 'STOPALL' || upperBody === 'UNSUBSCRIBE' || upperBody === 'CANCEL' || upperBody === 'END' || upperBody === 'QUIT') {
      if (user) {
        await supabase
          .from('users')
          .update({ stripe_status: 'cancelled' })
          .eq('phone_number', phoneNumber)
      }
      // Twilio automatically sends the opt-out message — return empty response
      return twimlResponse('')
    }

    if (upperBody === 'START' || upperBody === 'YES' || upperBody === 'UNSTOP') {
      if (user) {
        // Existing user resubscribing
        await supabase
          .from('users')
          .update({ stripe_status: 'trial' })
          .eq('phone_number', phoneNumber)
        return twimlResponse("Welcome back! You're resubscribed to Life. Covered. Just text me anything on your schedule and I'll take it from there.")
      }
      // New user — fall through to onboarding below
    }

    if (upperBody === 'HELP') {
      return twimlResponse('Life. Covered. — AI family coordination. Text your schedule and Mary handles the rest. Support: support@lifecovered.app. Msg & data rates may apply. Reply STOP to cancel.')
    }

    // Quiet hours — no responses 10pm to 7am in user's timezone
    if (user) {
      const userTimezone = (user as any).timezone ?? 'America/Chicago'
      const currentHour = parseInt(
        new Date().toLocaleString('en-US', {
          timeZone: userTimezone,
          hour: 'numeric',
          hour12: false,
        })
      )
      if (currentHour >= 22 || currentHour < 7) {
        // Log the message but don't respond
        await supabase.from('messages').insert({
          family_id: user.family_id,
          user_id: user.id,
          direction: 'inbound',
          channel,
          content: body,
        })
        return twimlResponse("It's late — I'll take care of this first thing in the morning! 🌙")
      }
    }

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

    // Check for pending age collection session
    const { data: agePendingSession } = user ? await supabase
      .from('dropzone_onboarding')
      .select('*')
      .eq('phone_number', `age_pending_${user.id}`)
      .maybeSingle() : { data: null }

    // Check for pending coordination reply
    const { data: coordPendingSession } = await supabase
      .from('dropzone_onboarding')
      .select('*')
      .eq('phone_number', `coord_pending_${phoneNumber}`)
      .maybeSingle()

    const responseText = activeSession
      ? await handleOnboarding(phoneNumber, body, activeSession as OnboardingSession)
      : coordPendingSession
        ? await handleCoordinationReply(body, coordPendingSession as OnboardingSession)
        : agePendingSession
          ? await handleAgePending(body, agePendingSession as OnboardingSession)
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
        .insert({ 
          name: `The ${firstName} Family`, 
          tier: 'solo',
          calendar_token: generateToken(),
        })
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

      // Save village members if any were provided
      let villageParseFailedMsg = ''
      if (sessionData.village_raw && sessionData.family_id) {
        const villageText = sessionData.village_raw
        console.error('Village raw:', villageText)
        const members = await parseVillageMember(villageText)
        console.error('Village parsed:', JSON.stringify(members))

        if (members.length === 0 && !sessionData.village_declined) {
          // Had text but couldn't parse valid name+phone
          villageParseFailedMsg = " One thing — I wasn't able to save your village member's contact info. You can add them anytime by texting me their name and a 10-digit phone number."
          console.error('Village parse failed — possible incomplete phone number')
        }

        for (const member of members) {
          // Check tier limits before adding
          const { count: memberCount } = await supabase
            .from('users')
            .select('*', { count: 'exact', head: true })
            .eq('family_id', sessionData.family_id)

          const { data: familyRaw } = await supabase
            .from('families')
            .select('tier')
            .eq('id', sessionData.family_id)
            .single()
          const familyTier = (familyRaw as { tier: string } | null)?.tier ?? 'solo'
          const tierLimits: Record<string, number> = { solo: 1, family: 4, village: 8 }
          const limit = tierLimits[familyTier] ?? 1

          if ((memberCount ?? 0) >= limit) {
            villageParseFailedMsg = ` One thing — you've reached the member limit for your current plan. To add more village members, you'll need to upgrade your plan at lifecovered.app.`
            break
          }

          const { error: villageError } = await supabase.from('users').insert({
            phone_number: member.phone,
            name: member.name,
            family_id: sessionData.family_id,
            role: 'village',
            stripe_status: 'village',
          })
          if (villageError) console.error('Village insert error:', JSON.stringify(villageError))

          // Send welcome text to village member
          if (!villageError) {
            const parentName = sessionData.name ?? 'Someone'
            await sendSMS(
              member.phone,
              `Hey ${member.name}! ${parentName} added you to their Life. Covered. village. I'm Mary, an AI coordinator — I'll reach out when I need your help coordinating pickups or schedules. Reply STOP anytime to opt out.`
            )
          }
        }
      }

      await supabase
        .from('dropzone_onboarding')
        .update({
          step: 'awaiting_ical',
          data: { ...sessionData },
        })
        .eq('phone_number', phoneNumber)

      const villageMsg = villageParseFailedMsg ? villageParseFailedMsg + ' ' : ''
      return `${villageMsg}Almost there! Want me to sync your schedule to Apple Calendar or Google Calendar automatically? Just say yes or no.`
    }

    case 'awaiting_ical': {
      const sessionData = session.data ?? {}
      const lowerBody = body.trim().toLowerCase()
      const wantsICal =
        lowerBody === 'yes' ||
        lowerBody === 'yeah' ||
        lowerBody === 'yep' ||
        lowerBody === 'sure' ||
        lowerBody === 'ok' ||
        lowerBody === 'okay' ||
        lowerBody.includes('yes')

      await supabase
        .from('dropzone_onboarding')
        .delete()
        .eq('phone_number', phoneNumber)

      if (wantsICal && sessionData.family_id) {
        const { data: familyRaw } = await supabase
          .from('families')
          .select('calendar_token')
          .eq('id', sessionData.family_id)
          .single()
        const family = familyRaw as { calendar_token: string } | null
        if (family?.calendar_token) {
          const icalUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/calendar/${family.calendar_token}/feed.ics`
          return `Here's your calendar link — add it to Apple Calendar or Google Calendar and every event I save will appear automatically:\n\n${icalUrl}\n\nWhat's the first thing on your schedule?`
        }
      }

      return "No problem! What's the first thing on your schedule? Just text me anything — a pickup, a school event, whatever's coming up."
    }

    case 'awaiting_child_age': {
      const sessionData = session.data ?? {}
      const childName = sessionData.child_name ?? 'your child'
      const childId = sessionData.child_id ?? ''
      const ageMatch = body.match(/\d+/)
      const age = ageMatch ? parseInt(ageMatch[0]) : null

      await supabase
        .from('dropzone_onboarding')
        .delete()
        .eq('phone_number', phoneNumber)

      if (age !== null && childId) {
        await supabase
          .from('children')
          .update({ age })
          .eq('id', childId)
        return `Got it — ${childName} is ${age}. All set!`
      }

      return `No worries — you can always update ${childName}'s age later if needed.`
    }

    default:
      return "Hey! Welcome to Covered 👋 I'm Mary. What's your name?"
  }
}

// ─── Age Pending Handler ──────────────────────────────────────────────────────

async function handleAgePending(body: string, session: OnboardingSession): Promise<string> {
  const sessionData = session.data ?? {}
  const childName = sessionData.child_name ?? 'your child'
  const childId = sessionData.child_id ?? ''

  // Delete the pending session regardless
  await supabase
    .from('dropzone_onboarding')
    .delete()
    .eq('phone_number', session.phone_number)

  const ageMatch = body.match(/\d+/)
  const age = ageMatch ? parseInt(ageMatch[0]) : null

  if (age !== null && childId) {
    await supabase
      .from('children')
      .update({ age })
      .eq('id', childId)
    return `Got it — ${childName} is ${age}. All set!`
  }

  return `No worries — you can always tell me ${childName}'s age later and I'll get the profile updated.`
}

// ─── Co-parent Coordination Handler ──────────────────────────────────────────

async function handleCoordinationReply(body: string, session: OnboardingSession): Promise<string> {
  const sessionData = session.data ?? {}
  const lowerBody = body.trim().toLowerCase()
  const parentPhone = sessionData.parent_phone ?? ''
  const parentName = sessionData.parent_name ?? 'Someone'
  const eventTitle = sessionData.event_title ?? 'the event'
  const eventDate = sessionData.event_date ?? ''
  const eventTime = sessionData.event_time ?? ''
  const childName = sessionData.child_name ?? ''
  const eventId = sessionData.event_id ?? ''

  await supabase
    .from('dropzone_onboarding')
    .delete()
    .eq('phone_number', session.phone_number)

  const confirmed =
    lowerBody === 'yes' ||
    lowerBody === 'yeah' ||
    lowerBody === 'yep' ||
    lowerBody === 'sure' ||
    lowerBody === 'ok' ||
    lowerBody === 'okay' ||
    lowerBody.includes('yes') ||
    lowerBody.includes('can do') ||
    lowerBody.includes('i got') ||
    lowerBody.includes('got it')

  if (confirmed) {
    // Update event assigned_to
    if (eventId) {
      const { data: villageUserRaw } = await supabase
        .from('users')
        .select('id')
        .eq('phone_number', session.phone_number.replace('coord_pending_', ''))
        .single()
      const villageUser = villageUserRaw as { id: string } | null
      if (villageUser?.id) {
        await supabase
          .from('events')
          .update({ assigned_to: villageUser.id, confirmed: true })
          .eq('id', eventId)
      }
    }

    // Notify parent
    if (parentPhone) {
      await sendSMS(
        parentPhone,
        `${sessionData.village_name ?? 'Your village member'} confirmed they'll cover ${childName ? childName + "'s " : ''}${eventTitle}${eventDate ? ' on ' + eventDate : ''}${eventTime ? ' at ' + eventTime : ''}. You're covered! 👍`
      )
    }

    return `Perfect — you're confirmed for ${childName ? childName + "'s " : ''}${eventTitle}${eventDate ? ' on ' + eventDate : ''}${eventTime ? ' at ' + eventTime : ''}. I'll remind you 2 hours before. 👍`
  } else {
    // Notify parent of decline
    if (parentPhone) {
      await sendSMS(
        parentPhone,
        `${sessionData.village_name ?? 'Your village member'} can't cover ${childName ? childName + "'s " : ''}${eventTitle}${eventDate ? ' on ' + eventDate : ''}. You may want to arrange alternative coverage.`
      )
    }

    return `No worries — I've let ${parentName} know. Thanks for getting back to me!`
  }
}

// ─── Token Generator ──────────────────────────────────────────────────────────

function generateToken(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let token = ''
  for (let i = 0; i < 24; i++) {
    token += chars[Math.floor(Math.random() * chars.length)]
  }
  return token
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
  const systemPrompt = `You are Mary, the warm and reliable coordinator behind Covered — a family logistics service. You have a perfect memory of every family you work with. You are specific, never generic. You always reference the actual names, dates, and details from the family context provided. You are conversational and human — never robotic, never use bullet points in messages, never say "I have logged your request", never use markdown formatting, asterisks, or bold text. You speak the way a brilliant, organized friend would speak over text. Keep responses concise — this is a text message, not an email. Maximum 3 sentences unless a summary is explicitly requested. Do not include intent classifications in your response. IMPORTANT: Reminders are automatic — when an event is saved, reminders fire automatically 2 hours before and 30 minutes before. Never ask the user when they want a reminder or for which event. Just confirm the event is saved and tell them reminders will go out automatically. Never ask clarifying questions about reminders. The family context may include elderly dependents — treat them with the same care as children but use age-appropriate language (appointments, rides, medications) rather than school/activity language. If a user wants to add a village member, ask for their name and a 10-digit phone number — if the number provided is incomplete or invalid, let them know politely and ask them to resend it. If recent messages include a CONFLICT notice, mention it naturally in your response — e.g. "Heads up — looks like that overlaps with something else on the schedule."`

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

Classify the intent internally (ADD_EVENT, QUERY, COORDINATE, FORWARD, CONFIRM, OTHER, ADD_VILLAGE) but do NOT include the intent in your response. Just respond naturally.

IMPORTANT: If the message contains ANY scheduling information, you MUST return a separate <event_data>...</event_data> block for EACH event mentioned. Use the exact ISO dates provided above. Example for multiple events:
<event_data>{"title": "Football", "event_date": "${todayISO}", "event_time": "18:00", "child_name": "JM", "notes": null, "recurring": null}</event_data>
<event_data>{"title": "Softball", "event_date": "${todayISO}", "event_time": "16:00", "child_name": "Estela", "notes": null, "recurring": null}</event_data>

For recurring events, set the "recurring" field to the interval: "weekly", "biweekly", "monthly", or null for one-time events. Example:
<event_data>{"title": "Doctor appointment", "event_date": "${todayISO}", "event_time": "14:00", "child_name": "Grandpa Joe", "notes": null, "recurring": "weekly"}</event_data>

If an event is recurring, your response MUST mention that it has been saved for the next 8 weeks and will need to be re-added after that.

If the message is adding a village member (someone with a name and phone number to coordinate with), return a <village_data> block:
<village_data>{"name": "Mia", "phone": "5124619644"}</village_data>

If the message asks someone to cover/handle/pick up/coordinate something involving a specific village member by name, return a <coordinate_data> block:
<coordinate_data>{"village_member_name": "Mia", "event_title": "Soccer pickup", "event_date": "${todayISO}", "event_time": "16:00", "child_name": "Estela"}</coordinate_data>

All data blocks will be stripped before sending to the user.`

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
    const newChildren = await extractAndStoreEvent(fullText, user)
    if (newChildren.length > 0) {
      const firstName = newChildren[0]!

      // Look up the newly created child record
      const { data: newChildRaw } = await supabase
        .from('children')
        .select('id')
        .eq('family_id', user.family_id)
        .ilike('name', `%${firstName}%`)
        .order('created_at', { ascending: false })
        .limit(1)
        .single()
      const newChild = newChildRaw as { id: string } | null

      // Create a pending session to capture the age response
      if (newChild?.id) {
        await supabase.from('dropzone_onboarding').insert({
          phone_number: `age_pending_${user.id}`,
          step: 'awaiting_child_age',
          data: {
            child_name: firstName,
            child_id: newChild.id,
            user_phone: user.id,
          },
        })
      }

      const names = newChildren.join(' and ')
      const agePrompt = newChildren.length === 1
        ? ` Quick one — how old is ${names}? I want to make sure I have their profile complete.`
        : ` Quick one — how old are ${names}? I want to make sure I have their profiles complete.`

      const stripped = fullText
        .replace(/<[a-z_]+>[\s\S]*?<\/[a-z_]+>/g, '')
        .replace(/<[a-z_]+>/g, '')
        .replace(/<\/[a-z_]+>/g, '')
        .replace(/\*Intent:[\s\S]*?\*/g, '')
        .replace(/Intent:\s*\w+\n?/g, '')
        .replace(/\*\*(.*?)\*\*/g, '$1')
        .replace(/\*(.*?)\*/g, '$1')
        .replace(/^#{1,3}\s+/gm, '')
        .replace(/^\d+\.\s+/gm, '')
        .trim()
      return stripped + agePrompt
    }
  }

  if (fullText.includes('<village_data>')) {
    await extractAndSaveVillageMember(fullText, user)
  }

  if (fullText.includes('<coordinate_data>')) {
    await handleCoordinationRequest(fullText, user)
  }

  return fullText
    .replace(/<[a-z_]+>[\s\S]*?<\/[a-z_]+>/g, '')
    .replace(/<[a-z_]+>/g, '')
    .replace(/<\/[a-z_]+>/g, '')
    .replace(/\*Intent:[\s\S]*?\*/g, '')
    .replace(/Intent:\s*\w+\n?/g, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/^#{1,3}\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .trim()
}

// ─── Event Extraction ─────────────────────────────────────────────────────────

async function extractAndStoreEvent(claudeText: string, user: User): Promise<string[]> {
  const newChildren: string[] = []

  try {
    const matches = [...claudeText.matchAll(/<event_data>([\s\S]*?)<\/event_data>/g)]
    if (matches.length === 0) return newChildren

    for (const match of matches) {
      if (!match[1]) continue

      try {
        const eventData = JSON.parse(match[1]) as {
          title: string
          event_date: string
          event_time: string | null
          child_name: string | null
          notes: string | null
          recurring: string | null
        }

        const { title, event_date, event_time, child_name, notes, recurring } = eventData

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

          if (!childId) {
            const isElderly = /grandp|grandm|nana|papa|pops|grammy|gramps|aunt|uncle/i.test(child_name)
            const { data: newChildRaw } = await supabase
              .from('children')
              .insert({
                family_id: user.family_id,
                name: child_name,
                age: null,
                type: isElderly ? 'elderly' : 'child',
              })
              .select('id')
              .single()
            const newChild = newChildRaw as { id: string } | null
            childId = newChild?.id ?? null

            if (!isElderly) {
              newChildren.push(child_name)
            }
          }
        }

        const dates = generateEventDates(event_date, recurring)

        for (const date of dates) {
          await supabase.from('events').insert({
            family_id: user.family_id,
            child_id: childId,
            title,
            event_date: date,
            event_time: event_time ?? null,
            notes: notes ?? null,
            confirmed: false,
          })

          // Check for conflicts on this date/time
          if (event_time && childId) {
            const { data: conflicts } = await supabase
              .from('events')
              .select('title, event_time')
              .eq('family_id', user.family_id)
              .eq('child_id', childId)
              .eq('event_date', date)
              .neq('event_time', event_time)
              .not('event_time', 'is', null)

            if (conflicts && conflicts.length > 0) {
              const conflictTitles = conflicts.map((c: any) => `${c.title} at ${c.event_time}`).join(', ')
              console.error(`Conflict detected for child ${childId} on ${date}: ${title} conflicts with ${conflictTitles}`)
              // Store conflict for response — will be picked up by callClaude
              await supabase.from('messages').insert({
                family_id: user.family_id,
                user_id: null,
                direction: 'system',
                channel: 'internal',
                content: `CONFLICT: ${child_name ?? 'Unknown'} has ${title} at ${event_time} but also ${conflictTitles} on ${date}`,
              })
            }
          }
        }
      } catch (innerErr) {
        console.error('Error parsing individual event_data block:', innerErr)
      }
    }
  } catch (err) {
    console.error('Event extraction error:', err)
  }

  return newChildren
}

async function extractAndSaveVillageMember(claudeText: string, user: User): Promise<void> {
  try {
    const match = claudeText.match(/<village_data>([\s\S]*?)<\/village_data>/)
    if (!match?.[1]) return

    const data = JSON.parse(match[1]) as { name: string; phone: string }
    if (!data.name || !data.phone) return

    const rawPhone = data.phone.replace(/[^\d]/g, '')
    const phone = rawPhone.length === 10 ? `+1${rawPhone}` : `+${rawPhone}`

    if (phone.length < 12) return

    // Check tier limits
    const { count: memberCount } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true })
      .eq('family_id', user.family_id)

    const { data: familyRaw } = await supabase
      .from('families')
      .select('tier')
      .eq('id', user.family_id)
      .single()
    const familyTier = (familyRaw as { tier: string } | null)?.tier ?? 'solo'
    const tierLimits: Record<string, number> = { solo: 1, family: 4, village: 8 }
    const limit = tierLimits[familyTier] ?? 1

    if ((memberCount ?? 0) >= limit) {
      await sendSMS(
        user.id,
        `You've reached the member limit for your ${familyTier} plan. To add more village members, upgrade your plan at lifecovered.app.`
      )
      return
    }

    await supabase.from('users').insert({
      phone_number: phone,
      name: data.name,
      family_id: user.family_id,
      role: 'village',
      stripe_status: 'village',
    })

    // Send welcome text to village member
    await sendSMS(
      phone,
      `Hey ${data.name}! ${user.name} added you to their Life. Covered. village. I'm Mary, an AI coordinator — I'll reach out when I need your help coordinating pickups or schedules. Reply STOP anytime to opt out.`
    )
  } catch (err) {
    console.error('Village member extraction error:', err)
  }
}

async function handleCoordinationRequest(claudeText: string, user: User): Promise<void> {
  try {
    const match = claudeText.match(/<coordinate_data>([\s\S]*?)<\/coordinate_data>/)
    if (!match?.[1]) return

    const data = JSON.parse(match[1]) as {
      village_member_name: string
      event_title: string
      event_date: string
      event_time: string | null
      child_name: string | null
    }

    // Find the village member by name
    const { data: villageRaw } = await supabase
      .from('users')
      .select('id, name, phone_number')
      .eq('family_id', user.family_id)
      .ilike('name', `%${data.village_member_name}%`)
      .single()

    const villager = villageRaw as { id: string; name: string; phone_number: string } | null
    if (!villager?.phone_number) return

    // Find the event to get its ID
    const { data: eventRaw } = await supabase
      .from('events')
      .select('id')
      .eq('family_id', user.family_id)
      .eq('event_date', data.event_date)
      .ilike('title', `%${data.event_title}%`)
      .single()
    const event = eventRaw as { id: string } | null

    // Create coordination pending session
    await supabase.from('dropzone_onboarding').insert({
      phone_number: `coord_pending_${villager.phone_number}`,
      step: 'awaiting_coordination_reply',
      data: {
        parent_phone: user.id,
        parent_name: user.name,
        village_name: villager.name,
        event_title: data.event_title,
        event_date: data.event_date ?? '',
        event_time: data.event_time ?? '',
        child_name: data.child_name ?? '',
        event_id: event?.id ?? '',
      },
    })

    // Text the village member
    const timeStr = data.event_time ? ` at ${data.event_time}` : ''
    const childStr = data.child_name ? ` for ${data.child_name}` : ''
    await sendSMS(
      villager.phone_number,
      `Hey ${villager.name}! ${user.name} is asking if you can cover ${data.event_title}${childStr} on ${data.event_date}${timeStr}. Can you make it? Reply YES or NO.`
    )
  } catch (err) {
    console.error('Coordination request error:', err)
  }
}

function generateEventDates(startDate: string, recurring: string | null): string[] {
  if (!recurring) return [startDate]

  const dates: string[] = []
  const base = new Date(startDate + 'T12:00:00Z')

  let intervalDays = 7
  if (recurring === 'biweekly') intervalDays = 14
  if (recurring === 'monthly') intervalDays = 30

  for (let i = 0; i < 8; i++) {
    const d = new Date(base.getTime() + i * intervalDays * 24 * 60 * 60 * 1000)
    dates.push(d.toISOString().split('T')[0]!)
  }

  return dates
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
- Accept ANY name format: full names, first names only, nicknames, initials like "J.M." or "JM", abbreviations
- Use the name EXACTLY as given — do not expand or modify it (e.g. "J.M." stays "J.M.", "JM" stays "JM")
- Ages may be listed separately from names — pair them in order. Examples:
  * "J.M. and Estela, ages 13 and 9" → J.M. is 13, Estela is 9
  * "J.M. and Estela 13 and 9" → J.M. is 13, Estela is 9
  * "Sarah 12 and Jake 8" → Sarah is 12, Jake is 8
  * "2 kids: Sarah and Jake, 12 and 8" → Sarah is 12, Jake is 8
- If no age given for a person, use null — do NOT assign someone else's age
- Grandpa/Grandma/Nana/Papa/Aunt/Uncle/Gramps/Grammy etc are always "elderly"
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

async function parseVillageMember(text: string): Promise<Array<{ name: string; phone: string }>> {
  // Strip common lead-in words first
  const cleaned = text
    .replace(/^(yes|yeah|yep|sure|ok|okay)[,.\s]+/i, '')
    .trim()

  // Quick check — must contain a phone number to be worth parsing
  if (!/\d{7,}/.test(cleaned)) return []

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
      messages: [{
        role: 'user',
        content: `Extract ALL people and their phone numbers from this text. There may be one or more people. Return ONLY valid JSON with no other text.

Text: "${cleaned}"

Return an array: [{"name": "Mia", "phone": "+15124619644"}, {"name": "Matt", "phone": "+15124611922"}]
- Format each phone as E.164 (+1XXXXXXXXXX for US numbers)
- Include every person who has a phone number
- Return empty array if no valid name+phone pairs found: []`
      }],
    }),
  })

  const result = await response.json() as { content?: Array<{ text?: string }> }
  const resultText = result.content?.[0]?.text?.trim() ?? '[]'

  try {
    const parsed = JSON.parse(resultText) as Array<{ name: string; phone: string }>
    return Array.isArray(parsed) ? parsed.filter(p => p.name && p.phone) : []
  } catch {
    return []
  }
}
// ─── SMS Helper ───────────────────────────────────────────────────────────────

async function sendSMS(to: string, message: string): Promise<void> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID
  const authToken = process.env.TWILIO_AUTH_TOKEN
  const from = process.env.TWILIO_PHONE_NUMBER

  if (!accountSid || !authToken || !from) {
    console.error('Twilio SMS credentials missing')
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
