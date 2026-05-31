/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */
// src/app/api/stripe/webhook/route.ts
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

interface UserRecord {
  id: string
  phone_number: string
  name: string
  stripe_customer_id: string | null
  stripe_status: string
}

export async function POST(req: NextRequest) {
  const body = await req.text()
  const signature = req.headers.get('stripe-signature')

  if (!signature) {
    return new NextResponse('Missing stripe-signature header', { status: 400 })
  }

  let event: Stripe.Event

  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!
    )
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err)
    return new NextResponse('Webhook signature verification failed', { status: 400 })
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        const customerId = session.customer as string

        if (customerId) {
          await supabase
            .from('users')
            .update({ stripe_status: 'active', stripe_customer_id: customerId })
            .eq('stripe_customer_id', customerId)
        }
        break
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription
        const customerId = subscription.customer as string

        await supabase
          .from('users')
          .update({ stripe_status: 'cancelled' })
          .eq('stripe_customer_id', customerId)

        const { data: usersRaw } = await supabase
          .from('users')
          .select('id, phone_number, name, stripe_customer_id, stripe_status')
          .eq('stripe_customer_id', customerId)

        const users = (usersRaw ?? []) as UserRecord[]
        const user = users[0]

        if (user) {
          await sendSMS(
            user.phone_number,
            `Hey ${user.name} — your Covered subscription has ended. Your family's schedule history is saved if you ever want to come back. Take care! 👋`
          )
        }
        break
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice
        const customerId = invoice.customer as string

        const { data: usersRaw } = await supabase
          .from('users')
          .select('id, phone_number, name, stripe_customer_id, stripe_status')
          .eq('stripe_customer_id', customerId)

        const users = (usersRaw ?? []) as UserRecord[]
        const user = users[0]

        if (user) {
          await sendSMS(
            user.phone_number,
            `Hey ${user.name} — your Covered payment didn't go through. Update your payment info to keep everything running: ${process.env.STRIPE_CUSTOMER_PORTAL_URL ?? 'https://billing.stripe.com'}`
          )
        }
        break
      }

      default:
        break
    }

    return new NextResponse('OK', { status: 200 })

  } catch (err) {
    console.error('Stripe webhook handler error:', err)
    return new NextResponse('Webhook handler failed', { status: 500 })
  }
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
