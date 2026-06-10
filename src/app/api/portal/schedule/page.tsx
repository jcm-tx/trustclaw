'use client'
// src/app/portal/schedule/page.tsx
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'

interface Event {
  id: string
  title: string
  event_date: string
  event_time: string | null
  confirmed: boolean
  children: { name: string; type: string } | null
  assigned_user: { name: string } | null
}

export default function PortalSchedulePage() {
  const [events, setEvents] = useState<Event[]>([])
  const [loading, setLoading] = useState(true)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const router = useRouter()

  useEffect(() => {
    void loadEvents()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadEvents() {
    const res = await fetch('/api/portal/events')
    if (res.status === 401) { router.push('/portal'); return }
    const data = await res.json() as { events: Event[] }
    setEvents(data.events ?? [])
    setLoading(false)
  }

  async function cancelEvent(id: string, title: string) {
    if (!confirm(`Cancel "${title}"?`)) return
    setDeletingId(id)
    await fetch('/api/portal/events', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    await loadEvents()
    setDeletingId(null)
  }

  function formatDate(dateStr: string): string {
    const date = new Date(dateStr + 'T12:00:00')
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })
    const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })
    if (dateStr === today) return 'Today'
    if (dateStr === tomorrow) return 'Tomorrow'
    return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
  }

  function formatTime(timeStr: string | null): string {
    if (!timeStr) return 'All day'
    const [hours, minutes] = timeStr.split(':').map(Number)
    const period = hours! >= 12 ? 'pm' : 'am'
    const displayHour = hours! % 12 || 12
    return `${displayHour}:${String(minutes).padStart(2, '0')}${period}`
  }

  // Group events by date
  const grouped: Record<string, Event[]> = {}
  for (const event of events) {
    grouped[event.event_date] ??= []
    grouped[event.event_date]!.push(event)
  }

  if (loading) return <div style={styles.loading}>Loading schedule...</div>

  return (
    <div style={styles.page}>
      <nav style={styles.nav}>
        <div style={styles.navLogo}>Life. Covered.</div>
        <div style={styles.navLinks}>
          <a href="/portal/home" style={styles.navLink}>Home</a>
          <a href="/portal/family" style={styles.navLink}>Family</a>
          <a href="/portal/schedule" style={styles.navLinkActive}>Schedule</a>
        </div>
      </nav>

      <div style={styles.content}>
        <div style={styles.pageHeader}>
          <h1 style={styles.pageTitle}>Schedule</h1>
          <p style={styles.pageSub}>Next 60 days · {events.length} event{events.length !== 1 ? 's' : ''}</p>
        </div>

        {events.length === 0 ? (
          <div style={styles.empty}>
            <div style={styles.emptyIcon}>📅</div>
            <div style={styles.emptyTitle}>Nothing scheduled yet</div>
            <div style={styles.emptySub}>Text Mary to add events to your schedule.</div>
            <a href={`sms:+14322203767`} style={styles.textMaryBtn}>Text Mary</a>
          </div>
        ) : (
          <div>
            {Object.entries(grouped).map(([date, dayEvents]) => (
              <div key={date} style={styles.dayGroup}>
                <div style={styles.dayHeader}>{formatDate(date)}</div>
                {dayEvents.map(event => (
                  <div key={event.id} style={styles.eventCard}>
                    <div style={styles.eventTime}>{formatTime(event.event_time)}</div>
                    <div style={styles.eventInfo}>
                      <div style={styles.eventTitle}>{event.title}</div>
                      <div style={styles.eventMeta}>
                        {event.children?.name && <span>{event.children.name}</span>}
                        {event.assigned_user?.name && <span> · {event.assigned_user.name}</span>}
                        {event.confirmed && <span style={styles.confirmedText}> · Confirmed ✓</span>}
                      </div>
                    </div>
                    <button
                      onClick={() => cancelEvent(event.id, event.title)}
                      style={styles.cancelBtn}
                      disabled={deletingId === event.id}
                    >
                      {deletingId === event.id ? '...' : 'Cancel'}
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: { minHeight: '100vh', background: '#FAF7F2', fontFamily: "'DM Sans', -apple-system, sans-serif" },
  loading: { display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', color: '#78716C' },
  nav: { background: '#FFFFFF', borderBottom: '1px solid #E7E3DC', padding: '0 40px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: '64px' },
  navLogo: { fontFamily: 'Georgia, serif', fontSize: '18px', fontWeight: '700', color: '#1C1917' },
  navLinks: { display: 'flex', alignItems: 'center', gap: '24px' },
  navLink: { fontSize: '14px', color: '#78716C', textDecoration: 'none', fontWeight: '500' },
  navLinkActive: { fontSize: '14px', color: '#2d6a4f', textDecoration: 'none', fontWeight: '600' },
  content: { maxWidth: '800px', margin: '0 auto', padding: '40px 24px' },
  pageHeader: { marginBottom: '32px' },
  pageTitle: { fontFamily: 'Georgia, serif', fontSize: '32px', fontWeight: '700', color: '#1C1917', margin: '0 0 4px' },
  pageSub: { fontSize: '15px', color: '#78716C', margin: '0' },
  empty: { background: '#FFFFFF', borderRadius: '16px', padding: '60px 40px', textAlign: 'center', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' },
  emptyIcon: { fontSize: '48px', marginBottom: '16px' },
  emptyTitle: { fontSize: '18px', fontWeight: '600', color: '#1C1917', marginBottom: '8px' },
  emptySub: { fontSize: '15px', color: '#78716C', marginBottom: '24px' },
  textMaryBtn: { display: 'inline-block', background: '#2d6a4f', color: '#FFF', textDecoration: 'none', borderRadius: '10px', padding: '12px 24px', fontSize: '15px', fontWeight: '600' },
  dayGroup: { marginBottom: '32px' },
  dayHeader: { fontSize: '13px', fontWeight: '700', color: '#78716C', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px', paddingLeft: '4px' },
  eventCard: { background: '#FFFFFF', borderRadius: '12px', padding: '16px 20px', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '16px', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' },
  eventTime: { fontSize: '14px', fontWeight: '600', color: '#2d6a4f', minWidth: '64px' },
  eventInfo: { flex: 1 },
  eventTitle: { fontSize: '15px', fontWeight: '500', color: '#1C1917' },
  eventMeta: { fontSize: '13px', color: '#78716C', marginTop: '2px' },
  confirmedText: { color: '#166534' },
  cancelBtn: { background: 'none', border: '1px solid #FCA5A5', borderRadius: '6px', padding: '6px 12px', fontSize: '13px', color: '#DC2626', cursor: 'pointer' },
}
