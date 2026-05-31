// src/app/api/stripe/webhook/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(req: NextRequest) {
  const body = await req.text()
  const signature = req.headers.get('stripe-signature')!

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
        const customerEmail = session.customer_details?.email

        // Find user by stripe_customer_id or email
        let query = supabase.from('users').select('*')
        if (customerId) {
          query = query.eq('stripe_customer_id', customerId)
        } else if (customerEmail) {
          query = query.eq('email', customerEmail)
        }

        const { data: users } = await query
        if (users && users.length > 0) {
          await supabase
            .from('users')
            .update({ stripe_status: 'active', stripe_customer_id: customerId })
            .eq('id', users[0].id)
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

        // Send offboarding message via Twilio
        const { data: users } = await supabase
          .from('users')
          .select('phone_number, name')
          .eq('stripe_customer_id', customerId)

        if (users && users.length > 0) {
          await sendSMS(
            users[0].phone_number,
            `Hey ${users[0].name} — your Covered subscription has ended. Your family's schedule history is saved if you ever want to come back. Take care! 👋`
          )
        }
        break
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice
        const customerId = invoice.customer as string

        const { data: users } = await supabase
          .from('users')
          .select('phone_number, name')
          .eq('stripe_customer_id', customerId)

        if (users && users.length > 0) {
          await sendSMS(
            users[0].phone_number,
            `Hey ${users[0].name} — your Covered payment didn't go through. Update your payment info here to keep everything running: ${process.env.STRIPE_CUSTOMER_PORTAL_URL ?? 'https://covered.app/billing'}`
          )
        }
        break
      }
    }

    return new NextResponse('OK', { status: 200 })

  } catch (err) {
    console.error('Stripe webhook handler error:', err)
    return new NextResponse('Webhook handler failed', { status: 500 })
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
