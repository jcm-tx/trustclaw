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
  family_id: string
  stripe_customer_id: string | null
  stripe_status: string
}

// Map Stripe price IDs to family tiers
function getTierFromPriceId(priceId: string): string {
  if (priceId === process.env.STRIPE_PRICE_SOLO) return 'solo'
  if (priceId === process.env.STRIPE_PRICE_FAMILY) return 'family'
  if (priceId === process.env.STRIPE_PRICE_VILLAGE) return 'village'
  return 'solo' // default
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

        if (!customerId) break

        // Get the price ID from the line items to determine tier
        let tier = 'solo'
        try {
          const lineItems = await stripe.checkout.sessions.listLineItems(session.id)
          const priceId = lineItems.data[0]?.price?.id
          if (priceId) tier = getTierFromPriceId(priceId)
        } catch (err) {
          console.error('Error fetching line items:', err)
        }

        // Update user stripe status
        const { data: usersRaw } = await supabase
          .from('users')
          .update({ stripe_status: 'active', stripe_customer_id: customerId })
          .eq('stripe_customer_id', customerId)
          .select('id, family_id')

        const users = (usersRaw ?? []) as { id: string; family_id: string }[]

        // Update family tier
        if (users.length > 0 && users[0]?.family_id) {
          await supabase
            .from('families')
            .update({ tier })
            .eq('id', users[0].family_id)
        }

        console.error(`Checkout completed — customer ${customerId}, tier: ${tier}`)
        break
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription
        const customerId = subscription.customer as string
        const priceId = subscription.items.data[0]?.price.id

        if (priceId) {
          const tier = getTierFromPriceId(priceId)

          // Find user and update family tier
          const { data: usersRaw } = await supabase
            .from('users')
            .select('id, family_id')
            .eq('stripe_customer_id', customerId)

          const users = (usersRaw ?? []) as { id: string; family_id: string }[]

          if (users.length > 0 && users[0]?.family_id) {
            await supabase
              .from('families')
              .update({ tier })
              .eq('id', users[0].family_id)

            console.error(`Subscription updated — customer ${customerId}, new tier: ${tier}`)
          }
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

        // Reset family tier to solo
        const { data: usersRaw } = await supabase
          .from('users')
          .select('id, phone_number, name, family_id, stripe_customer_id, stripe_status')
          .eq('stripe_customer_id', customerId)

        const users = (usersRaw ?? []) as UserRecord[]
        const user = users[0]

        if (user) {
          // Reset tier
          await supabase
            .from('families')
            .update({ tier: 'solo' })
            .eq('id', user.family_id)

          await sendSMS(
            user.phone_number,
            `Hey ${user.name} — your Life. Covered. subscription has ended. Your family's schedule history is saved if you ever want to come back. Take care! 👋`
          )
        }
        break
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice
        const customerId = invoice.customer as string

        // Create Stripe customer portal session for easy payment update
        let portalUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://lifecovered.app'
        try {
          const portalSession = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: process.env.NEXT_PUBLIC_SITE_URL ?? 'https://lifecovered.app',
          })
          portalUrl = portalSession.url
        } catch (err) {
          console.error('Error creating portal session:', err)
        }

        const { data: usersRaw } = await supabase
          .from('users')
          .select('id, phone_number, name, family_id, stripe_customer_id, stripe_status')
          .eq('stripe_customer_id', customerId)

        const users = (usersRaw ?? []) as UserRecord[]
        const user = users[0]

        if (user) {
          await sendSMS(
            user.phone_number,
            `Hey ${user.name} — your Life. Covered. payment didn't go through. Update your payment info to keep everything running: ${portalUrl}`
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
