'use client'
// src/app/portal/page.tsx
import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function PortalLoginPage() {
  const [phone, setPhone] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const router = useRouter()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    const res = await fetch('/api/portal/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    })

    const data = await res.json() as { error?: string }

    if (!res.ok) {
      setError(data.error ?? 'Something went wrong.')
      setLoading(false)
      return
    }

    // Store phone in sessionStorage for verify step
    sessionStorage.setItem('portal_phone', phone)
    router.push('/portal/verify')
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <div style={styles.logo}>Life. Covered.</div>
        <h1 style={styles.heading}>Family Portal</h1>
        <p style={styles.sub}>Enter your phone number and we&apos;ll text you a login code.</p>

        <form onSubmit={handleSubmit} style={styles.form}>
          <input
            type="tel"
            placeholder="(555) 555-5555"
            value={phone}
            onChange={e => setPhone(e.target.value)}
            style={styles.input}
            required
          />
          {error && <p style={styles.error}>{error}</p>}
          <button type="submit" style={styles.button} disabled={loading}>
            {loading ? 'Sending code...' : 'Send login code'}
          </button>
        </form>

        <p style={styles.hint}>
          Don&apos;t have an account?{' '}
          <a href="sms:+14322203767&body=Hi" style={styles.link}>
            Text Mary to get started
          </a>
        </p>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    background: '#FAF7F2',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px',
    fontFamily: "'DM Sans', -apple-system, sans-serif",
  },
  card: {
    background: '#FFFFFF',
    borderRadius: '16px',
    padding: '48px 40px',
    width: '100%',
    maxWidth: '420px',
    boxShadow: '0 4px 24px rgba(0,0,0,0.06)',
    textAlign: 'center',
  },
  logo: {
    fontFamily: 'Georgia, serif',
    fontSize: '22px',
    fontWeight: '700',
    color: '#1C1917',
    marginBottom: '24px',
  },
  heading: {
    fontSize: '28px',
    fontWeight: '700',
    color: '#1C1917',
    margin: '0 0 8px',
    fontFamily: 'Georgia, serif',
  },
  sub: {
    fontSize: '15px',
    color: '#78716C',
    margin: '0 0 32px',
    lineHeight: '1.5',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  input: {
    width: '100%',
    padding: '14px 16px',
    borderRadius: '10px',
    border: '1.5px solid #E7E3DC',
    fontSize: '16px',
    color: '#1C1917',
    background: '#FAF7F2',
    outline: 'none',
    boxSizing: 'border-box',
  },
  button: {
    width: '100%',
    padding: '14px',
    borderRadius: '10px',
    background: '#2d6a4f',
    color: '#FFFFFF',
    fontSize: '16px',
    fontWeight: '600',
    border: 'none',
    cursor: 'pointer',
  },
  error: {
    color: '#DC2626',
    fontSize: '14px',
    margin: '0',
    textAlign: 'left',
  },
  hint: {
    marginTop: '24px',
    fontSize: '14px',
    color: '#78716C',
  },
  link: {
    color: '#2d6a4f',
    textDecoration: 'none',
    fontWeight: '500',
  },
}
