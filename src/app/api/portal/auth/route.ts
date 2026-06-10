// src/app/api/portal/auth/route.ts
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// POST /api/portal/auth — request a login code
// POST /api/portal/auth?action=verify — verify code and set session
export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const action = searchParams.get('action')

  if (action === 'verify') {
    return handleVerify(req)
  }

  return handleRequestCode(req)
}

async function handleRequestCode(req: NextRequest): Promise<NextResponse> {
  try {
    const { phone } = await req.json() as { phone: string }

    // Clean phone number
    const cleaned = phone.replace(/[^\d]/g, '')
    const phoneNumber = cleaned.length === 10 ? `+1${cleaned}` : `+${cleaned}`

    // Check user exists
    const { data: userRaw } = await supabase
      .from('users')
      .select('id, name, stripe_status')
      .eq('phone_number', phoneNumber)
      .single()

    const user = userRaw as { id: string; name: string; stripe_status: string } | null

    if (!user) {
      return NextResponse.json({ error: 'No account found for that number. Text Hi to (432) 220-3767 to get started.' }, { status: 404 })
    }

    // Generate 6-digit code
    const code = Math.floor(100000 + Math.random() * 900000).toString()
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000) // 10 minutes

    // Store code
    await supabase.from('portal_tokens').insert({
      phone_number: phoneNumber,
      token: code,
      type: 'code',
      expires_at: expiresAt.toISOString(),
      used: false,
    })

    // Send SMS with code
    await sendSMS(phoneNumber, `Your Life. Covered. login code is: ${code}\n\nExpires in 10 minutes. Don't share this code with anyone.`)

    return NextResponse.json({ success: true })

  } catch (err) {
    console.error('Auth request error:', err)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}

async function handleVerify(req: NextRequest): Promise<NextResponse> {
  try {
    const { phone, code } = await req.json() as { phone: string; code: string }

    const cleaned = phone.replace(/[^\d]/g, '')
    const phoneNumber = cleaned.length === 10 ? `+1${cleaned}` : `+${cleaned}`

    // Find valid code
    const { data: tokenRaw } = await supabase
      .from('portal_tokens')
      .select('id, expires_at, used')
      .eq('phone_number', phoneNumber)
      .eq('token', code)
      .eq('type', 'code')
      .eq('used', false)
      .single()

    const token = tokenRaw as { id: string; expires_at: string; used: boolean } | null

    if (!token) {
      return NextResponse.json({ error: 'Invalid code. Please try again.' }, { status: 400 })
    }

    if (new Date(token.expires_at) < new Date()) {
      return NextResponse.json({ error: 'Code expired. Please request a new one.' }, { status: 400 })
    }

    // Mark code as used
    await supabase
      .from('portal_tokens')
      .update({ used: true })
      .eq('id', token.id)

    // Create session token
    const sessionToken = generateSessionToken()
    const sessionExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days

    await supabase.from('portal_tokens').insert({
      phone_number: phoneNumber,
      token: sessionToken,
      type: 'session',
      expires_at: sessionExpires.toISOString(),
      used: false,
    })

    // Set session cookie
    const response = NextResponse.json({ success: true })
    response.cookies.set('portal_session', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      expires: sessionExpires,
      path: '/',
      sameSite: 'lax',
    })

    return response

  } catch (err) {
    console.error('Auth verify error:', err)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}

function generateSessionToken(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let token = ''
  for (let i = 0; i < 48; i++) {
    token += chars[Math.floor(Math.random() * chars.length)]
  }
  return token
}

async function sendSMS(to: string, message: string): Promise<void> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID
  const authToken = process.env.TWILIO_AUTH_TOKEN
  const from = process.env.TWILIO_PHONE_NUMBER

  if (!accountSid || !authToken || !from) return

  await fetch(
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
}
