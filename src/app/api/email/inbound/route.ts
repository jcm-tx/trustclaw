/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/prefer-regexp-exec */
/* eslint-disable @typescript-eslint/no-unsafe-return */
// src/app/api/email/inbound/route.ts
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()

    // Extract email fields from Sendgrid inbound parse
    const from = formData.get('from') as string ?? ''
    const to = formData.get('to') as string ?? ''
    const subject = formData.get('subject') as string ?? ''
    const text = formData.get('text') as string ?? ''
    const html = formData.get('html') as string ?? ''
    const attachments = formData.get('attachments') as string ?? '0'

    // Extract sender email address
    const angleMatch = /<(.+?)>/.exec(from)
    const plainMatch = /([^\s]+@[^\s]+)/.exec(from)
    const senderEmail = angleMatch?.[1] ?? plainMatch?.[1] ?? from.trim()

    if (!senderEmail) {
      console.error('No sender email found')
      return new NextResponse('OK', { status: 200 })
    }

    // Route support emails directly to Gmail — don't process as schedule
    const isSupportEmail = to.toLowerCase().includes('support@lifecovered.app')
    if (isSupportEmail) {
      await sendReplyEmail(
        'hustle1272@gmail.com',
        `Support request from ${senderEmail}: ${subject}`,
        `From: ${senderEmail}\nSubject: ${subject}\n\n${text || html.replace(/<[^>]*>/g, ' ').trim()}`
      )
      // Send acknowledgment to sender
      await sendReplyEmail(
        senderEmail,
        'Re: ' + subject,
        `Hi! We got your message and will get back to you shortly.\n\nFor faster help, you can also text Mary at (866) 618-2822.\n\nLife. Covered.`
      )
      return new NextResponse('OK', { status: 200 })
    }

    // Look up user by email
    const { data: userRaw } = await supabase
      .from('users')
      .select('id, name, phone_number, family_id, stripe_status')
      .eq('email', senderEmail.toLowerCase())
      .single()

    const user = userRaw as {
      id: string
      name: string
      phone_number: string
      family_id: string
      stripe_status: string
    } | null

    if (!user) {
      console.error('No user found for email:', senderEmail)
      // Send a reply email explaining how to register
      await sendReplyEmail(
        senderEmail,
        'Register your email with Life. Covered.',
        `Hi there! We received your email but couldn't match it to a Life. Covered. account.\n\nTo forward schedules and calendars to us, you'll need to register this email address first.\n\nJust text Mary: "my email is ${senderEmail}"\n\nText Mary at (866) 618-2822 or via WhatsApp at (432) 220-3767.\n\nQuestions? Reply to this email and we'll help you get set up.\n\nLife. Covered.`
      )
      return new NextResponse('OK', { status: 200 })
    }

    if (!['trial', 'active'].includes(user.stripe_status)) {
      return new NextResponse('OK', { status: 200 })
    }

    // Build content for Claude to parse
    // Use plain text first, fall back to HTML stripped of tags
    const emailContent = text || html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

    // Handle PDF attachments
    const attachmentCount = parseInt(attachments) || 0
    let pdfContent = ''

    if (attachmentCount > 0) {
      // Get attachment data from form
      for (let i = 1; i <= attachmentCount; i++) {
        const attachmentInfo = formData.get(`attachment-info`) as string
        if (attachmentInfo) {
          try {
            const info = JSON.parse(attachmentInfo) as Record<string, any>
            for (const [key, val] of Object.entries(info)) {
              if (val.type === 'application/pdf') {
                const pdfData = formData.get(key) as File | null
                if (pdfData) {
                  const arrayBuffer = await pdfData.arrayBuffer()
                  const base64 = Buffer.from(arrayBuffer).toString('base64')
                  const parsedText = await parsePdfWithClaude(base64)
                  pdfContent += '\n\nPDF CONTENT:\n' + parsedText
                }
              }
            }
          } catch (err) {
            console.error('Error parsing attachment info:', err)
          }
        }
      }
    }

    // Check for PDF URL in email body even without attachment
    const pdfUrlMatch = /https?:\/\/[^\s<>"]+\.pdf/i.exec(emailContent)
    if (pdfUrlMatch && attachmentCount === 0) {
      try {
        const pdfUrl = pdfUrlMatch[0]
        const pdfResponse = await fetch(pdfUrl)
        if (pdfResponse.ok) {
          const arrayBuffer = await pdfResponse.arrayBuffer()
          const base64 = Buffer.from(arrayBuffer).toString('base64')
          pdfContent += '\n\nPDF FROM LINK:\n' + await parsePdfWithClaude(base64)
        }
      } catch (err) {
        console.error('Error fetching PDF from email URL:', err)
      }
    }

    const fullContent = `Email subject: ${subject}\n\nEmail body:\n${emailContent}${pdfContent}`

    // Extract events via Claude
    const events = await extractEventsFromEmail(fullContent, user.name)

    if (events.length === 0) {
      await sendSMS(
        user.phone_number,
        `Hey ${user.name} — I got your email but couldn't find any events to add. Try forwarding emails with specific dates and times, or text me directly with the schedule.`
      )
      return new NextResponse('OK', { status: 200 })
    }

    // Save all events to database
    let savedCount = 0
    for (const event of events) {
      if (!event.event_date || !/^\d{4}-\d{2}-\d{2}$/.test(event.event_date)) continue

      // Try to match child name
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

    // Log the email as a message
    await supabase.from('messages').insert({
      family_id: user.family_id,
      user_id: user.id,
      direction: 'inbound',
      channel: 'email',
      content: `Email: ${subject}`,
    })

    // Notify user via SMS
    const eventSummary = events
      .slice(0, 3)
      .map(e => `${e.title}${e.event_date ? ' on ' + e.event_date : ''}${e.event_time ? ' at ' + e.event_time : ''}`)
      .join(', ')

    const moreText = events.length > 3 ? ` and ${events.length - 3} more` : ''

    await sendSMS(
      user.phone_number,
      `Got your email "${subject}"! I found ${savedCount} event${savedCount !== 1 ? 's' : ''} — ${eventSummary}${moreText}. All saved and reminders set. 📅`
    )

    return new NextResponse('OK', { status: 200 })

  } catch (err) {
    console.error('Email inbound error:', err)
    return new NextResponse('OK', { status: 200 }) // Always return 200 to Sendgrid
  }
}

// ─── PDF Parsing ──────────────────────────────────────────────────────────────

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

// ─── Event Extraction ─────────────────────────────────────────────────────────

async function extractEventsFromEmail(content: string, _parentName: string): Promise<Array<{
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
        content: `Today is ${todayISO}. Extract ALL events, activities, appointments, and scheduled items from this email content. Return ONLY valid JSON, no other text.

Email content:
${content}

Return this format:
{"events": [{"title": "Soccer practice", "event_date": "2026-06-10", "event_time": "16:00", "child_name": "Jake", "notes": null}]}

Rules:
- Include every event, activity, meeting, appointment, or deadline mentioned
- Use YYYY-MM-DD for dates, HH:MM for times (24hr format)
- If no specific date, make your best guess based on context (e.g. "next Tuesday")
- child_name should be the child the event is for, or null if unclear
- Return empty array if no events found: {"events": []}
- Do not include past events`
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

// ─── Email Reply Helper ───────────────────────────────────────────────────────

async function sendReplyEmail(to: string, subject: string, body: string): Promise<void> {
  const apiKey = process.env.SENDGRID_API_KEY
  if (!apiKey) return

  await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: 'schedule@lifecovered.app', name: 'Life. Covered.' },
      reply_to: { email: 'hustle1272@gmail.com', name: 'Life. Covered. Support' },
      subject,
      content: [{ type: 'text/plain', value: body }],
    }),
  })
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
