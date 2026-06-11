/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/prefer-regexp-exec */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-return */
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
  stripe_customer_id: string | null
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

    if (upperBody === 'START' || upperBody === 'UNSTOP') {
      if (user) {
        // Check if user is in an active onboarding session
        const { data: existingSession } = await supabase
          .from('dropzone_onboarding')
          .select('step')
          .eq('phone_number', phoneNumber)
          .maybeSingle()

        if (!existingSession) {
          // No active session — this is a resubscribe
          await supabase
            .from('users')
            .update({ stripe_status: 'trial' })
            .eq('phone_number', phoneNumber)
          return twimlResponse("Welcome back! You're resubscribed to Life. Covered. Just text me anything on your schedule and I'll take it from there.")
        }
        // Has active session — fall through to onboarding handler
      }
      // New user — fall through to onboarding below
    }

    if (upperBody === 'HELP') {
      return twimlResponse('Life. Covered. — AI family coordination. Text your schedule and Mary handles the rest. Support: support@lifecovered.app. Msg & data rates may apply. Reply STOP to cancel.')
    }

    if (upperBody === 'BILLING' || upperBody === 'SUBSCRIPTION' || upperBody === 'MANAGE PLAN') {
      try {
        if (user?.stripe_customer_id) {
          const portalRes = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
            method: 'POST',
            headers: {
              'Authorization': `Basic ${Buffer.from(`${process.env.STRIPE_SECRET_KEY}:`).toString('base64')}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
              customer: user.stripe_customer_id,
              return_url: process.env.NEXT_PUBLIC_SITE_URL ?? 'https://lifecovered.app',
            }),
          })
          const portal = await portalRes.json() as { url?: string }
          if (portal.url) {
            return twimlResponse(`Here's your billing portal — manage your subscription, update payment info, or cancel anytime: ${portal.url}`)
          }
        }
        return twimlResponse(`Manage your Life. Covered. subscription at lifecovered.app or contact support@lifecovered.app for help.`)
      } catch {
        return twimlResponse(`For billing help contact support@lifecovered.app`)
      }
    }

    // Email registration — "my email is john@gmail.com"
    const emailRegMatch = /(?:my email(?: is| address is)?|email me at|register email|add email)[:\s]+([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i.exec(body)
    const standaloneEmailMatch = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.exec(body.trim())
    const detectedEmail = emailRegMatch?.[1] ?? standaloneEmailMatch?.[0] ?? null

    if (detectedEmail && user) {
      await supabase
        .from('users')
        .update({ email: detectedEmail.toLowerCase() })
        .eq('id', user.id)

      await supabase.from('messages').insert({
        family_id: user.family_id,
        user_id: user.id,
        direction: 'inbound',
        channel,
        content: body,
      })

      const confirmMsg = `Got it — I've registered ${detectedEmail} for your account. Forward any school emails, calendars, or schedules to schedule@lifecovered.app and I'll automatically add the events. 📧`

      await supabase.from('messages').insert({
        family_id: user.family_id,
        user_id: user.id,
        direction: 'outbound',
        channel,
        content: confirmMsg,
      })

      return twimlResponse(confirmMsg)
    }

    // School calendar import — detect intent or PDF URL
    const importIntent = /import|school calendar|school schedule|upload calendar|add calendar/i.test(body)
    const pdfUrlMatch = /https?:\/\/[^\s]+\.pdf/i.exec(body)

    if (user && pdfUrlMatch) {
      // Parent texted a direct PDF link
      const pdfUrl = pdfUrlMatch[0]
      return twimlResponse(await handlePdfUrl(pdfUrl, user, channel))
    }

    if (user && importIntent && !pdfUrlMatch) {
      // Parent wants to import but didn't provide URL yet
      return twimlResponse(`Sure! Two ways to import your school calendar:\n\n1. Forward the email from your school to schedule@lifecovered.app\n2. Text me the direct link to the PDF calendar\n\nI'll pull out all the events and add them automatically. 📅`)
    }

    // Note: Quiet hours (10pm-7am) only apply to OUTBOUND proactive messages
    // (reminders, briefings, coordination requests to village members)
    // Mary always responds to parents who text her directly

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

          // Send welcome text — respect quiet hours
          if (!villageError) {
            const welcomeHour = parseInt(
              new Date().toLocaleString('en-US', {
                timeZone: 'America/Chicago',
                hour: 'numeric',
                hour12: false,
              })
            )
            const parentName = sessionData.name ?? 'Someone'
            if (welcomeHour >= 7 && welcomeHour < 22) {
              await sendSMS(
                member.phone,
                `Hey ${member.name}! ${parentName} added you to their Life. Covered. village. I'm Mary, an AI coordinator — I'll reach out when I need your help coordinating pickups or schedules. Reply STOP anytime to opt out.`
              )
            }
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
          const shortUrl = await shortenUrl(icalUrl)
          return `Here's your calendar link — add it to Apple Calendar or Google Calendar and every event I save will appear automatically:\n\n${shortUrl}\n\nWhat's the first thing on your schedule?`
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

async function handlePdfUrl(url: string, user: User, channel: string): Promise<string> {
  try {
    // Fetch the PDF
    const response = await fetch(url)
    if (!response.ok) {
      return `I wasn't able to fetch that PDF — it may require a login or the link may have expired. Try forwarding the email to schedule@lifecovered.app instead.`
    }

    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('pdf') && !url.toLowerCase().includes('.pdf')) {
      return `That link doesn't appear to be a PDF. Try forwarding the email directly to schedule@lifecovered.app and I'll parse it from there.`
    }

    const arrayBuffer = await response.arrayBuffer()
    const base64 = Buffer.from(arrayBuffer).toString('base64')

    // Parse PDF with Claude
    const pdfText = await parsePdfWithClaude(base64)
    if (!pdfText) {
      return `I had trouble reading that PDF. Try forwarding it as an email attachment to schedule@lifecovered.app instead.`
    }

    // Extract events
    const events = await extractEventsFromContent(pdfText, user)
    if (events.length === 0) {
      return `I read the PDF but couldn't find any events with dates. It may be formatted in a way I can't parse yet. Try forwarding to schedule@lifecovered.app and I'll take another look.`
    }

    // Save events
    let savedCount = 0
    for (const event of events) {
      if (!event.event_date || !/^\d{4}-\d{2}-\d{2}$/.test(event.event_date)) continue

      let childId: string | null = null
      if (event.child_name) {
        const { data: childRaw } = await supabase
          .from('children')
          .select('id')
          .eq('family_id', user.family_id)
          .ilike('name', `%${event.child_name}%`)
          .single()
        const child = childRaw as { id: string } | null
        childId = child?.id ?? null
      }

      await supabase.from('events').insert({
        family_id: user.family_id,
        child_id: childId,
        title: event.title,
        event_date: event.event_date,
        event_time: event.event_time ?? null,
        notes: event.notes ?? null,
        confirmed: false,
      })
      savedCount++
    }

    await supabase.from('messages').insert({
      family_id: user.family_id,
      user_id: user.id,
      direction: 'inbound',
      channel,
      content: `PDF import: ${url}`,
    })

    const summary = events
      .slice(0, 3)
      .map((e: any) => `${e.title}${e.event_date ? ' on ' + e.event_date : ''}`)
      .join(', ')
    const moreText = events.length > 3 ? ` and ${events.length - 3} more` : ''

    return `Got it! I found ${savedCount} event${savedCount !== 1 ? 's' : ''} in that PDF — ${summary}${moreText}. All saved and reminders set. 📅`

  } catch (err) {
    console.error('PDF URL handling error:', err)
    return `Something went wrong reading that PDF. Try forwarding it to schedule@lifecovered.app instead.`
  }
}

async function parsePdfWithClaude(base64Pdf: string): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: base64Pdf,
            },
          },
          {
            type: 'text',
            text: 'Extract all events, dates, times, and activities from this document. List them clearly with dates and times where available.',
          },
        ],
      }],
    }),
  })

  const result = await response.json() as { content?: Array<{ text?: string }> }
  return result.content?.[0]?.text ?? ''
}

async function extractEventsFromContent(content: string, _user: User): Promise<Array<{
  title: string
  event_date: string
  event_time: string | null
  child_name: string | null
  notes: string | null
}>> {
  const now = new Date()
  const todayISO = now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Today is ${todayISO}. Extract ALL events from this content. Return ONLY valid JSON.

Content:
${content}

Return: {"events": [{"title": "Soccer practice", "event_date": "2026-06-10", "event_time": "16:00", "child_name": null, "notes": null}]}
- YYYY-MM-DD dates, HH:MM times (24hr)
- Skip past events
- Return {"events": []} if none found`
      }],
    }),
  })

  const result = await response.json() as { content?: Array<{ text?: string }> }
  const text = result.content?.[0]?.text?.trim() ?? '{"events": []}'

  try {
    const parsed = JSON.parse(text) as { events: Array<any> }
    return parsed.events ?? []
  } catch {
    return []
  }
}

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
  const systemPrompt = `You are Mary, the warm and reliable coordinator behind Covered — a family logistics service. You have a perfect memory of every family you work with. You are specific, never generic. You always reference the actual names, dates, and details from the family context provided. You are conversational and human — never robotic, never use bullet points in messages, never say "I have logged your request", never use markdown formatting, asterisks, or bold text. You speak the way a brilliant, organized friend would speak over text. Keep responses concise — this is a text message, not an email. Maximum 3 sentences unless a summary is explicitly requested. Do not include intent classifications in your response. IMPORTANT: Reminders are automatic — when an event is saved, reminders fire automatically 2 hours before and 30 minutes before. Never ask the user when they want a reminder or for which event. Just confirm the event is saved and tell them reminders will go out automatically. Never ask clarifying questions about reminders. The family context may include elderly dependents — treat them with the same care as children but use age-appropriate language (appointments, rides, medications) rather than school/activity language. If a user wants to add a village member, ask for their name and a 10-digit phone number — if the number provided is incomplete or invalid, let them know politely and ask them to resend it. CONFLICTS: If recent messages include a CONFLICT notice, you MUST mention it clearly and directly in your response — e.g. "Heads up — that overlaps with [other event] for [child name]. You may want to sort that out." Do not bury or skip conflict notices. CALENDAR: If the user asks for their calendar link, sync link, iCal, or how to add their schedule to their phone/calendar, return a <send_ical/> tag in your response and tell them you're sending their calendar link. PORTAL: If the user asks for their portal, dashboard, account access, or login link, tell them to visit ${process.env.NEXT_PUBLIC_APP_URL}/portal and log in with their phone number.`

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

If the message asks to cancel, remove, or delete an event or recurring events, return a <cancel_event> block:
<cancel_event>{"title": "Dentist", "child_name": "Jake", "cancel_all": true}</cancel_event>
- Set "cancel_all" to true if cancelling all occurrences (recurring), false if cancelling a specific date
- If cancelling a specific date, add "event_date": "YYYY-MM-DD"
- Your response should confirm what was cancelled

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

  if (fullText.includes('<cancel_event>')) {
    await handleEventCancellation(fullText, user)
  }

  if (fullText.includes('<send_ical/>') || fullText.includes('<send_ical />')) {
    const icalMsg = await getIcalMessage(user)
    const stripped = fullText
      .replace(/<[a-z_/\s]+>/g, '')
      .replace(/<\/[a-z_]+>/g, '')
      .replace(/\*Intent:[\s\S]*?\*/g, '')
      .replace(/Intent:\s*\w+\n?/g, '')
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/\*(.*?)\*/g, '$1')
      .replace(/^#{1,3}\s+/gm, '')
      .replace(/^\d+\.\s+/gm, '')
      .trim()
    return stripped + '\n\n' + icalMsg
  }

  return fullText
    .replace(/<[a-z_]+>[\s\S]*?<\/[a-z_]+>/g, '')
    .replace(/<[a-z_]+\/>/g, '')
    .replace(/<[a-z_]+\s*\/>/g, '')
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
            // Don't create a child record if the name matches the parent
            const isParent = user.name.toLowerCase().includes(child_name.toLowerCase()) ||
              child_name.toLowerCase().includes(user.name.toLowerCase().split(' ')[0]!)
            if (isParent) {
              console.error('Skipping child creation — name matches parent:', child_name)
            } else {
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

async function shortenUrl(url: string): Promise<string> {
  try {
    const res = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`)
    if (!res.ok) return url
    const short = await res.text()
    return short.startsWith('https://tinyurl.com') ? short.trim() : url
  } catch {
    return url
  }
}

async function getIcalMessage(user: User): Promise<string> {
  try {
    const { data: familyRaw } = await supabase
      .from('families')
      .select('calendar_token')
      .eq('id', user.family_id)
      .single()
    const family = familyRaw as { calendar_token: string } | null
    if (!family?.calendar_token) return "I don't have a calendar link set up for your account yet. Contact support@lifecovered.app and we'll get that sorted."
    const icalUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/calendar/${family.calendar_token}/feed.ics`
    const shortUrl = await shortenUrl(icalUrl)
    return `Here's your calendar link — add it to Apple Calendar or Google Calendar once and every event I save will appear automatically:\n\n${shortUrl}`
  } catch {
    return "I had trouble finding your calendar link. Text us at support@lifecovered.app and we'll sort it out."
  }
}

async function handleEventCancellation(claudeText: string, user: User): Promise<void> {
  try {
    const match = claudeText.match(/<cancel_event>([\s\S]*?)<\/cancel_event>/)
    if (!match?.[1]) return

    const data = JSON.parse(match[1]) as {
      title: string
      child_name: string | null
      cancel_all: boolean
      event_date: string | null
    }

    // Find child ID if child name provided
    let childId: string | null = null
    if (data.child_name) {
      const { data: childRaw } = await supabase
        .from('children')
        .select('id')
        .eq('family_id', user.family_id)
        .ilike('name', `%${data.child_name}%`)
        .single()
      const child = childRaw as { id: string } | null
      childId = child?.id ?? null
    }

    // Build delete query
    let query = supabase
      .from('events')
      .delete()
      .eq('family_id', user.family_id)
      .ilike('title', `%${data.title}%`)

    if (childId) query = query.eq('child_id', childId)
    if (!data.cancel_all && data.event_date) query = query.eq('event_date', data.event_date)

    const { error } = await query

    if (error) {
      console.error('Event cancellation error:', error)
    }
  } catch (err) {
    console.error('handleEventCancellation error:', err)
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

    // Text the village member — respect their quiet hours
    const villagerHour = parseInt(
      new Date().toLocaleString('en-US', {
        timeZone: 'America/Chicago',
        hour: 'numeric',
        hour12: false,
      })
    )

    const timeStr = data.event_time ? ` at ${data.event_time}` : ''
    const childStr = data.child_name ? ` for ${data.child_name}` : ''
    const coordMessage = `Hey ${villager.name}! ${user.name} is asking if you can cover ${data.event_title}${childStr} on ${data.event_date}${timeStr}. Can you make it? Reply YES or NO.`

    if (villagerHour >= 22 || villagerHour < 7) {
      // Queue for morning — store in dropzone_onboarding with pending_send flag
      await supabase.from('dropzone_onboarding').insert({
        phone_number: `coord_queued_${villager.phone_number}_${Date.now()}`,
        step: 'pending_send',
        data: {
          to: villager.phone_number,
          message: coordMessage,
          parent_phone: user.id,
          parent_name: user.name,
          village_name: villager.name,
        },
      })
      // Notify parent that the request will go out in the morning
      await sendSMS(
        user.id,
        `Got it — it's late so I'll reach out to ${villager.name} first thing in the morning to confirm. I'll let you know what they say! 🌙`
      )
    } else {
      await sendSMS(villager.phone_number, coordMessage)
    }
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
  const whatsappNumber = process.env.TWILIO_PHONE_NUMBER
  const tollFreeNumber = process.env.TWILIO_TOLL_FREE_NUMBER ?? process.env.TWILIO_PHONE_NUMBER

  if (!accountSid || !authToken) {
    console.error('Twilio credentials missing')
    return
  }

  // Use toll-free for SMS, original number for WhatsApp
  const isWhatsApp = to.startsWith('whatsapp:')
  const from = isWhatsApp
    ? `whatsapp:${whatsappNumber}`
    : tollFreeNumber!
  const formattedTo = isWhatsApp ? to : to.replace('whatsapp:', '')

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: formattedTo, From: from, Body: message }),
    }
  )

  if (!response.ok) {
    console.error('Twilio SMS failed:', await response.text())
  }
}
