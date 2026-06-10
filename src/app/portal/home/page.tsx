'use client'
// src/app/portal/home/page.tsx
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

interface FamilyData {
  children: Array<{ id: string; name: string; age: number | null; type: string }>
  village: Array<{ id: string; name: string; role: string }>
}

export default function PortalHomePage() {
  const [events, setEvents] = useState<Event[]>([])
  const [family, setFamily] = useState<FamilyData>({ children: [], village: [] })
  const [loading, setLoading] = useState(true)
  const [userName, setUserName] = useState('')
  const router = useRouter()

  useEffect(() => {
    void loadData()
  }, [])

  async function loadData() {
    const [eventsRes, familyRes] = await Promise.all([
      fetch('/api/portal/events'),
      fetch('/api/portal/family'),
    ])

    if (eventsRes.status === 401 || familyRes.status === 401) {
      router.push('/portal')
      return
    }

    const eventsData = await eventsRes.json() as { events: Event[] }
    const familyData = await familyRes.json() as FamilyData

    setEvents(eventsData.events ?? [])
    setFamily(familyData)
    setLoading(false)
  }

  async function handleLogout() {
    await fetch('/api/portal/auth?action=logout', { method: 'POST' })
    router.push('/portal')
  }

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })
  const todayEvents = events.filter(e => e.event_date === today)
  const upcomingEvents = events.filter(e => e.event_date > today).slice(0, 5)
  const kids = family.children.filter(c => c.type !== 'elderly')
  const elderly = family.children.filter(c => c.type === 'elderly')

  function formatDate(dateStr: string): string {
    const date = new Date(dateStr + 'T12:00:00')
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  }

  function formatTime(timeStr: string | null): string {
    if (!timeStr) return ''
    const [hours, minutes] = timeStr.split(':').map(Number)
    const period = hours! >= 12 ? 'pm' : 'am'
    const displayHour = hours! % 12 || 12
    return `${displayHour}:${String(minutes).padStart(2, '0')}${period}`
  }

  if (loading) {
    return (
      <div style={styles.page}>
        <div style={styles.loading}>Loading your family dashboard...</div>
      </div>
    )
  }

  return (
    <div style={styles.page}>
      <nav style={styles.nav}>
        <div style={styles.navLogo}>Life. Covered.</div>
        <div style={styles.navLinks}>
          <a href="/portal/home" style={styles.navLinkActive}>Home</a>
          <a href="/portal/family" style={styles.navLink}>Family</a>
          <a href="/portal/schedule" style={styles.navLink}>Schedule</a>
          <button onClick={handleLogout} style={styles.logoutBtn}>Log out</button>
        </div>
      </nav>

      <div style={styles.content}>
        <h1 style={styles.greeting}>
          {new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 17 ? 'Good afternoon' : 'Good evening'}{userName ? `, ${userName}` : ''}.
        </h1>

        {/* Stats row */}
        <div style={styles.statsRow}>
          <div style={styles.statCard}>
            <div style={styles.statNumber}>{kids.length + elderly.length}</div>
            <div style={styles.statLabel}>Family members</div>
          </div>
          <div style={styles.statCard}>
            <div style={styles.statNumber}>{family.village.length}</div>
            <div style={styles.statLabel}>Village members</div>
          </div>
          <div style={styles.statCard}>
            <div style={styles.statNumber}>{events.length}</div>
            <div style={styles.statLabel}>Upcoming events</div>
          </div>
          <div style={styles.statCard}>
            <div style={styles.statNumber}>{todayEvents.length}</div>
            <div style={styles.statLabel}>Today</div>
          </div>
        </div>

        {/* Today */}
        <div style={styles.section}>
          <h2 style={styles.sectionTitle}>Today</h2>
          {todayEvents.length === 0 ? (
            <div style={styles.empty}>Nothing scheduled today — enjoy the free day! ☀️</div>
          ) : (
            <div style={styles.eventList}>
              {todayEvents.map(event => (
                <div key={event.id} style={styles.eventCard}>
                  <div style={styles.eventTime}>{formatTime(event.event_time)}</div>
                  <div style={styles.eventInfo}>
                    <div style={styles.eventTitle}>{event.title}</div>
                    {event.children && (
                      <div style={styles.eventMeta}>{event.children.name}</div>
                    )}
                  </div>
                  {event.confirmed && <div style={styles.confirmedBadge}>Confirmed</div>}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Coming up */}
        {upcomingEvents.length > 0 && (
          <div style={styles.section}>
            <h2 style={styles.sectionTitle}>Coming up</h2>
            <div style={styles.eventList}>
              {upcomingEvents.map(event => (
                <div key={event.id} style={styles.eventCard}>
                  <div style={styles.eventDate}>{formatDate(event.event_date)}</div>
                  <div style={styles.eventInfo}>
                    <div style={styles.eventTitle}>{event.title}</div>
                    <div style={styles.eventMeta}>
                      {event.children?.name && <span>{event.children.name}</span>}
                      {event.event_time && <span> · {formatTime(event.event_time)}</span>}
                      {event.assigned_user && <span> · {event.assigned_user.name}</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <a href="/portal/schedule" style={styles.viewAll}>View full schedule →</a>
          </div>
        )}

        {/* Quick actions */}
        <div style={styles.section}>
          <h2 style={styles.sectionTitle}>Quick actions</h2>
          <div style={styles.actionGrid}>
            <a href="/portal/family" style={styles.actionCard}>
              <div style={styles.actionIcon}>👨‍👧‍👦</div>
              <div style={styles.actionLabel}>Manage family</div>
            </a>
            <a href="/portal/schedule" style={styles.actionCard}>
              <div style={styles.actionIcon}>📅</div>
              <div style={styles.actionLabel}>View schedule</div>
            </a>
            <a href={`sms:+14322203767&body=Hi`} style={styles.actionCard}>
              <div style={styles.actionIcon}>💬</div>
              <div style={styles.actionLabel}>Text Mary</div>
            </a>
            <a href={`sms:+14322203767&body=BILLING`} style={styles.actionCard}>
              <div style={styles.actionIcon}>💳</div>
              <div style={styles.actionLabel}>Billing</div>
            </a>
          </div>
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    background: '#FAF7F2',
    fontFamily: "'DM Sans', -apple-system, sans-serif",
  },
  loading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100vh',
    color: '#78716C',
    fontSize: '15px',
  },
  nav: {
    background: '#FFFFFF',
    borderBottom: '1px solid #E7E3DC',
    padding: '0 40px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: '64px',
  },
  navLogo: {
    fontFamily: 'Georgia, serif',
    fontSize: '18px',
    fontWeight: '700',
    color: '#1C1917',
  },
  navLinks: {
    display: 'flex',
    alignItems: 'center',
    gap: '24px',
  },
  navLink: {
    fontSize: '14px',
    color: '#78716C',
    textDecoration: 'none',
    fontWeight: '500',
  },
  navLinkActive: {
    fontSize: '14px',
    color: '#2d6a4f',
    textDecoration: 'none',
    fontWeight: '600',
  },
  logoutBtn: {
    background: 'none',
    border: '1px solid #E7E3DC',
    borderRadius: '8px',
    padding: '6px 14px',
    fontSize: '14px',
    color: '#78716C',
    cursor: 'pointer',
  },
  content: {
    maxWidth: '800px',
    margin: '0 auto',
    padding: '40px 24px',
  },
  greeting: {
    fontFamily: 'Georgia, serif',
    fontSize: '32px',
    fontWeight: '700',
    color: '#1C1917',
    margin: '0 0 32px',
  },
  statsRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: '16px',
    marginBottom: '40px',
  },
  statCard: {
    background: '#FFFFFF',
    borderRadius: '12px',
    padding: '20px',
    textAlign: 'center',
    boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
  },
  statNumber: {
    fontSize: '32px',
    fontWeight: '700',
    color: '#2d6a4f',
    fontFamily: 'Georgia, serif',
  },
  statLabel: {
    fontSize: '13px',
    color: '#78716C',
    marginTop: '4px',
  },
  section: {
    marginBottom: '40px',
  },
  sectionTitle: {
    fontSize: '18px',
    fontWeight: '600',
    color: '#1C1917',
    margin: '0 0 16px',
  },
  empty: {
    background: '#FFFFFF',
    borderRadius: '12px',
    padding: '24px',
    color: '#78716C',
    fontSize: '15px',
    textAlign: 'center',
  },
  eventList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  eventCard: {
    background: '#FFFFFF',
    borderRadius: '12px',
    padding: '16px 20px',
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
  },
  eventTime: {
    fontSize: '14px',
    fontWeight: '600',
    color: '#2d6a4f',
    minWidth: '56px',
  },
  eventDate: {
    fontSize: '13px',
    fontWeight: '600',
    color: '#2d6a4f',
    minWidth: '80px',
  },
  eventInfo: {
    flex: 1,
  },
  eventTitle: {
    fontSize: '15px',
    fontWeight: '500',
    color: '#1C1917',
  },
  eventMeta: {
    fontSize: '13px',
    color: '#78716C',
    marginTop: '2px',
  },
  confirmedBadge: {
    fontSize: '12px',
    background: '#DCFCE7',
    color: '#166534',
    padding: '4px 10px',
    borderRadius: '20px',
    fontWeight: '500',
  },
  viewAll: {
    display: 'inline-block',
    marginTop: '12px',
    fontSize: '14px',
    color: '#2d6a4f',
    textDecoration: 'none',
    fontWeight: '500',
  },
  actionGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: '16px',
  },
  actionCard: {
    background: '#FFFFFF',
    borderRadius: '12px',
    padding: '24px 16px',
    textAlign: 'center',
    textDecoration: 'none',
    boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
    transition: 'transform 0.1s',
  },
  actionIcon: {
    fontSize: '28px',
    marginBottom: '8px',
  },
  actionLabel: {
    fontSize: '14px',
    color: '#44403C',
    fontWeight: '500',
  },
}
