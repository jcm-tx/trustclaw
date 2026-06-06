// src/app/api/calendar/[token]/route.ts
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

interface EventRow {
  title: string
  event_date: string
  event_time: string | null
  notes: string | null
  children: { name: string } | { name: string }[] | null
  assigned_user: { name: string } | { name: string }[] | null
}

export async function GET(
  req: Request,
  { params }: { params: { token: string } }
) {
  const { token } = params

  // Look up family by calendar token
  const { data: familyRaw, error: familyError } = await supabase
    .from('families')
    .select('id, name')
    .eq('calendar_token', token)
    .single()

  if (familyError || !familyRaw) {
    return new NextResponse('Calendar not found', { status: 404 })
  }

  const family = familyRaw as { id: string; name: string }

  // Get all upcoming events (next 90 days) plus past 30 days
  const now = new Date()
  const pastDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    .toISOString().split('T')[0]!
  const futureDate = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)
    .toISOString().split('T')[0]!

  const { data: eventsRaw } = await supabase
    .from('events')
    .select('title, event_date, event_time, notes, children(name), assigned_user:assigned_to(name)')
    .eq('family_id', family.id)
    .gte('event_date', pastDate)
    .lte('event_date', futureDate)
    .order('event_date', { ascending: true })

  const events = (eventsRaw ?? []) as EventRow[]

  // Build iCal content
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Life. Covered.//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${family.name} — Life. Covered.`,
    'X-WR-TIMEZONE:America/Chicago',
    'X-WR-CALDESC:Family schedule managed by Mary from Life. Covered.',
  ]

  for (const event of events) {
    const childRaw = Array.isArray(event.children) ? event.children[0] : event.children
    const assignedRaw = Array.isArray(event.assigned_user) ? event.assigned_user[0] : event.assigned_user

    const childName = childRaw?.name ?? null
    const assignedName = assignedRaw?.name ?? null

    // Build event title
    const summary = childName
      ? `${event.title} — ${childName}`
      : event.title

    // Build description
    const descParts: string[] = []
    if (assignedName) descParts.push(`Assigned to: ${assignedName}`)
    if (event.notes) descParts.push(event.notes)
    descParts.push('Managed by Life. Covered.')
    const description = descParts.join('\\n')

    // Format dates
    const dateStr = event.event_date.replace(/-/g, '')
    const uid = `${dateStr}-${event.title.replace(/\s+/g, '-').toLowerCase()}@lifecovered.app`

    if (event.event_time) {
      // Timed event
      const [hours, minutes] = event.event_time.split(':').map(Number)
      const startTime = `${dateStr}T${String(hours).padStart(2, '0')}${String(minutes).padStart(2, '0')}00`
      
      // Default 1 hour duration
      const endHours = (hours! + 1) % 24
      const endTime = `${dateStr}T${String(endHours).padStart(2, '0')}${String(minutes).padStart(2, '0')}00`

      lines.push('BEGIN:VEVENT')
      lines.push(`UID:${uid}`)
      lines.push(`DTSTART;TZID=America/Chicago:${startTime}`)
      lines.push(`DTEND;TZID=America/Chicago:${endTime}`)
      lines.push(`SUMMARY:${escapeIcal(summary)}`)
      lines.push(`DESCRIPTION:${escapeIcal(description)}`)
      lines.push(`DTSTAMP:${formatNow()}`)
      lines.push('END:VEVENT')
    } else {
      // All-day event
      lines.push('BEGIN:VEVENT')
      lines.push(`UID:${uid}`)
      lines.push(`DTSTART;VALUE=DATE:${dateStr}`)
      lines.push(`DTEND;VALUE=DATE:${dateStr}`)
      lines.push(`SUMMARY:${escapeIcal(summary)}`)
      lines.push(`DESCRIPTION:${escapeIcal(description)}`)
      lines.push(`DTSTAMP:${formatNow()}`)
      lines.push('END:VEVENT')
    }
  }

  lines.push('END:VCALENDAR')

  const ical = lines.join('\r\n')

  return new NextResponse(ical, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="lifecovered-${token.slice(0, 8)}.ics"`,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
  })
}

function escapeIcal(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
}

function formatNow(): string {
  return new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z'
}
