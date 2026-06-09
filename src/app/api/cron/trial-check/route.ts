/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
// src/app/api/cron/trial-check/route.ts
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Beta mode — use discounted price IDs until 50 subscribers
async function isBetaActive(): Promise<boolean> {
  const { count } = await supabase
    .from('users')
    .select('*', { count: 'exact', head: true })
    .eq('role', 'parent')
    .eq('stripe_status', 'active')
  return (count ?? 0) < 50
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  try {
    const now = new Date()
    const betaActive = await isBetaActive()

    const { data: trialUsers, error } = await supabase
      .from('users')
      .select('*, families(*)')
      .eq('stripe_status', 'trial')
      .not('trial_start', 'is', null)

    if (error) {
      console.error('Error fetching trial users:', error)
      return new NextResponse('Error fetching users', { status: 500 })
    }

    if (!trialUsers || trialUsers.length === 0) {
      return new NextResponse('No trial users', { status: 200 })
    }

    for (const user of trialUsers) {
      const trialStart = new Date(user.trial_start)
      const daysSinceStart = Math.floor(
        (now.getTime() - trialStart.getTime()) / (1000 * 60 * 60 * 24)
      )

      // Day 6 — first payment reminder
      if (daysSinceStart === 6) {
        const paymentLink = await createStripePaymentLink(user, betaActive)
        const eventCount = await getEventCount(user.family_id)
        const betaMsg = betaActive
          ? `Lock in our beta rate — Solo for $9/mo for life, never goes up.`
          : `Keep it going for just $12/month.`
        await sendSMS(
          user.phone_number,
          `Hey ${user.name}! Your Life. Covered. trial ends tomorrow. You've got ${eventCount} events tracked and your family all set up. ${betaMsg} Tap here to continue: ${paymentLink}`
        )
      }

      // Day 7 — final reminder
      if (daysSinceStart === 7) {
        const paymentLink = await createStripePaymentLink(user, betaActive)
        const betaMsg = betaActive
          ? `Lock in $9/mo for life before your trial ends`
          : `Don't lose your family's schedule`
        await sendSMS(
          user.phone_number,
          `Last day of your trial, ${user.name}! ${betaMsg} — subscribe here: ${paymentLink}`
        )
      }

      // Day 8 — suspend service
      if (daysSinceStart >= 8) {
        await supabase
          .from('users')
          .update({ stripe_status: 'expired' })
          .eq('id', user.id)

        await sendSMS(
          user.phone_number,
          `Hey ${user.name} — your Life. Covered. trial has ended. Your family's data is safe and waiting whenever you're ready: ${process.env.NEXT_PUBLIC_SITE_URL}`
        )
      }
    }

    return new NextResponse(`Processed ${trialUsers.length} trial users`, { status: 200 })

  } catch (err) {
    console.error('Trial check cron error:', err)
    return new NextResponse('Cron job failed', { status: 500 })
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function createStripePaymentLink(
  user: {
    name: string
    phone_number: string
    stripe_customer_id: string | null
    family_id: string
    families: { tier: string } | null
  },
  betaActive: boolean
): Promise<string> {
  try {
    const tier = user.families?.tier ?? 'solo'

    // Use beta price IDs during beta period, full price IDs after
    const priceMap: Record<string, string> = betaActive
      ? {
          solo: process.env.STRIPE_PRICE_BETA_SOLO ?? process.env.STRIPE_PRICE_SOLO!,
          family: process.env.STRIPE_PRICE_BETA_FAMILY ?? process.env.STRIPE_PRICE_FAMILY!,
          village: process.env.STRIPE_PRICE_BETA_VILLAGE ?? process.env.STRIPE_PRICE_VILLAGE!,
        }
      : {
          solo: process.env.STRIPE_PRICE_SOLO!,
          family: process.env.STRIPE_PRICE_FAMILY!,
          village: process.env.STRIPE_PRICE_VILLAGE!,
        }

    const priceId = priceMap[tier] ?? priceMap.solo!

    const paymentLink = await stripe.paymentLinks.create({
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: {
        user_phone: user.phone_number,
        family_id: user.family_id,
      },
    })

    return paymentLink.url
  } catch (err) {
    console.error('Error creating Stripe payment link:', err)
    return process.env.NEXT_PUBLIC_SITE_URL ?? 'https://lifecovered.app'
  }
}

async function getEventCount(familyId: string): Promise<number> {
  const { count } = await supabase
    .from('events')
    .select('*', { count: 'exact', head: true })
    .eq('family_id', familyId)
  return count ?? 0
}

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
