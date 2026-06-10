// src/app/api/admin/dashboard/route.ts
// Protected by secret URL — no additional auth needed
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(): Promise<NextResponse> {
  try {
    const now = new Date()
    const today = now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()

    const [
      { count: totalFamilies },
      { count: trialUsers },
      { count: activeSubscribers },
      { count: expiredUsers },
      { count: totalEvents },
      { count: totalMessages },
      { count: eventsToday },
      { count: messagesLast24h },
      { count: newSignupsToday },
      { count: newSignupsThisWeek },
      { data: recentMessages },
      { data: recentSignups },
      { data: stuckUsers },
    ] = await Promise.all([
      supabase.from('families').select('*', { count: 'exact', head: true }),
      supabase.from('users').select('*', { count: 'exact', head: true }).eq('stripe_status', 'trial').eq('role', 'parent'),
      supabase.from('users').select('*', { count: 'exact', head: true }).eq('stripe_status', 'active').eq('role', 'parent'),
      supabase.from('users').select('*', { count: 'exact', head: true }).eq('stripe_status', 'expired').eq('role', 'parent'),
      supabase.from('events').select('*', { count: 'exact', head: true }),
      supabase.from('messages').select('*', { count: 'exact', head: true }),
      supabase.from('events').select('*', { count: 'exact', head: true }).eq('event_date', today),
      supabase.from('messages').select('*', { count: 'exact', head: true }).gte('created_at', yesterday),
      supabase.from('users').select('*', { count: 'exact', head: true }).gte('created_at', today).eq('role', 'parent'),
      supabase.from('users').select('*', { count: 'exact', head: true }).gte('created_at', weekAgo).eq('role', 'parent'),
      supabase.from('messages')
        .select('id, direction, channel, content, created_at, users(name, phone_number)')
        .order('created_at', { ascending: false })
        .limit(50),
      supabase.from('users')
        .select('id, name, phone_number, stripe_status, created_at, families(name, tier)')
        .eq('role', 'parent')
        .order('created_at', { ascending: false })
        .limit(20),
      supabase.from('dropzone_onboarding')
        .select('phone_number, step, created_at')
        .not('phone_number', 'like', 'coord_%')
        .not('phone_number', 'like', 'age_pending_%')
        .order('created_at', { ascending: true }),
    ])

    return NextResponse.json({
      stats: {
        totalFamilies: totalFamilies ?? 0,
        trialUsers: trialUsers ?? 0,
        activeSubscribers: activeSubscribers ?? 0,
        expiredUsers: expiredUsers ?? 0,
        totalEvents: totalEvents ?? 0,
        totalMessages: totalMessages ?? 0,
        eventsToday: eventsToday ?? 0,
        messagesLast24h: messagesLast24h ?? 0,
        newSignupsToday: newSignupsToday ?? 0,
        newSignupsThisWeek: newSignupsThisWeek ?? 0,
      },
      recentMessages: recentMessages ?? [],
      recentSignups: recentSignups ?? [],
      stuckUsers: stuckUsers ?? [],
    })

  } catch (err) {
    console.error('Admin dashboard error:', err)
    return NextResponse.json({ error: 'Failed to load dashboard' }, { status: 500 })
  }
}
