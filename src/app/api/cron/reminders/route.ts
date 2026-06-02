/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-explicit-any */
// src/app/api/cron/reminders/route.ts
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

    // Get all events today that haven't had reminders sent yet
    const { data: events, error } = await supabase
      .from('events')
      .select(`
        id,
        title,
        event_date,
        event_time,
        family_id,
        confirmed,
        reminder_sent_2hr,
        reminder_sent_30min,
        assigned_to,
        children(name),
        assigned_user:assigned_to(name, phone_number)
      `)
      .eq('event_date', todayISO)
      .not('event_time', 'is', null)

    if (error) {
      console.error('Error fetching events:', error)
      return new NextResponse('Error fetching events', { status: 500 })
    }

    if (!events || events.length === 0) {
      return new NextResponse('No events today', { status: 200 })
    }

    let remindersSent = 0

    for (const event of events) {
      try {
        if (!event.event_time) continue

        // Parse event time into a Date object
        const [hours, minutes] = (event.event_time as string).split(':').map(Number)
        const eventTime = new Date(now)
        eventTime.setHours(hours!, minutes!, 0, 0)

        const minutesUntilEvent = (eventTime.getTime() - now.getTime()) / (1000 * 60)

        // Get family members to notify
        const { data: familyMembers } = await supabase
          .from('users')
          .select('id, name, phone_number, stripe_status')
          .eq('family_id', event.family_id)
          .in('stripe_status', ['trial', 'active'])

        if (!familyMembers || familyMembers.length === 0) continue

        const childName = event.children?.name ?? null
        const assignedUserRaw = Array.isArray(event.assigned_user) ? event.assigned_user[0] : event.assigned_user
        const assignedName = assignedUserRaw?.name ?? null
        const assignedPhone = assignedUserRaw?.phone_number ?? null

        // 2-hour reminder (between 110-130 minutes out)
        if (
          minutesUntilEvent >= 110 &&
          minutesUntilEvent <= 130 &&
          !event.reminder_sent_2hr
        ) {
          const message = generate2HrReminder({
            title: event.title,
            eventTime: event.event_time,
            childName,
            assignedName,
          })

          // Send to assigned person if set, otherwise all family members
          const recipients = assignedPhone
            ? [assignedPhone]
            : familyMembers.map(m => m.phone_number)

          for (const phone of recipients) {
            await sendSMS(phone, message)
            remindersSent++
          }

          await supabase
            .from('events')
            .update({ reminder_sent_2hr: true })
            .eq('id', event.id)
        }

        // 30-minute reminder (between 25-35 minutes out)
        if (
          minutesUntilEvent >= 25 &&
          minutesUntilEvent <= 35 &&
          !event.reminder_sent_30min
        ) {
          const message = generate30MinReminder({
            title: event.title,
            eventTime: event.event_time,
            childName,
            assignedName,
          })

          const recipients = assignedPhone
            ? [assignedPhone]
            : familyMembers.map(m => m.phone_number)

          for (const phone of recipients) {
            await sendSMS(phone, message)
            remindersSent++
          }

          await supabase
            .from('events')
            .update({ reminder_sent_30min: true })
            .eq('id', event.id)
        }

      } catch (err) {
        console.error(`Error processing event ${event.id}:`, err)
      }
    }

    return new NextResponse(`Reminders sent: ${remindersSent}`, { status: 200 })

  } catch (err) {
    console.error('Reminders cron error:', err)
    return new NextResponse('Cron job failed', { status: 500 })
  }
}

// ─── Reminder Message Generators ─────────────────────────────────────────────

function generate2HrReminder({
  title,
  eventTime,
  childName,
  assignedName,
}: {
  title: string
  eventTime: string
  childName: string | null
  assignedName: string | null
}): string {
  const timeStr = formatTime(eventTime)
  const who = assignedName ? `You're on for this one` : `Heads up`
  const kid = childName ? ` for ${childName}` : ''
  return `${who} — ${title}${kid} is in 2 hours at ${timeStr}. 👍`
}

function generate30MinReminder({
  title,
  eventTime,
  childName,
  assignedName,
}: {
  title: string
  eventTime: string
  childName: string | null
  assignedName: string | null
}): string {
  const timeStr = formatTime(eventTime)
  const kid = childName ? ` ${childName}'s` : ''
  return `30 minutes —${kid} ${title} at ${timeStr}. You've got this! 🙌`
}

function formatTime(time: string): string {
  const [hoursStr, minutesStr] = time.split(':')
  const hours = parseInt(hoursStr ?? '0')
  const minutes = parseInt(minutesStr ?? '0')
  const period = hours >= 12 ? 'pm' : 'am'
  const displayHours = hours > 12 ? hours - 12 : hours === 0 ? 12 : hours
  const displayMinutes = minutes === 0 ? '' : `:${minutes.toString().padStart(2, '0')}`
  return `${displayHours}${displayMinutes}${period}`
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
