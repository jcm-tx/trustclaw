// src/app/api/portal/family/route.ts
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getPortalSession } from '~/lib/portal-auth'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// GET — fetch family data (kids + village members)
export async function GET(): Promise<NextResponse> {
  const session = await getPortalSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const [{ data: children }, { data: village }] = await Promise.all([
    supabase
      .from('children')
      .select('id, name, age, school, type')
      .eq('family_id', session.familyId)
      .order('type')
      .order('name'),
    supabase
      .from('users')
      .select('id, name, phone_number, role')
      .eq('family_id', session.familyId)
      .neq('id', session.userId)
      .order('name'),
  ])

  return NextResponse.json({ children: children ?? [], village: village ?? [] })
}

// POST — add or update a child or village member
export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getPortalSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json() as {
    type: 'child' | 'village'
    id?: string
    name: string
    age?: number | null
    school?: string | null
    childType?: 'child' | 'elderly'
    phone?: string
    role?: string
  }

  if (body.type === 'child') {
    if (body.id) {
      // Update existing child
      await supabase
        .from('children')
        .update({ name: body.name, age: body.age ?? null, school: body.school ?? null })
        .eq('id', body.id)
        .eq('family_id', session.familyId)
    } else {
      // Add new child
      await supabase.from('children').insert({
        family_id: session.familyId,
        name: body.name,
        age: body.age ?? null,
        school: body.school ?? null,
        type: body.childType ?? 'child',
      })
    }
  }

  if (body.type === 'village') {
    if (body.id) {
      // Update existing village member
      await supabase
        .from('users')
        .update({ name: body.name })
        .eq('id', body.id)
        .eq('family_id', session.familyId)
    } else if (body.phone) {
      // Add new village member
      const rawPhone = body.phone.replace(/[^\d]/g, '')
      const phone = rawPhone.length === 10 ? `+1${rawPhone}` : `+${rawPhone}`
      await supabase.from('users').insert({
        phone_number: phone,
        name: body.name,
        family_id: session.familyId,
        role: body.role ?? 'village',
        stripe_status: 'village',
      })
    }
  }

  return NextResponse.json({ success: true })
}

// DELETE — remove a child or village member
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const session = await getPortalSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id, type } = await req.json() as { id: string; type: 'child' | 'village' }

  if (type === 'child') {
    await supabase
      .from('children')
      .delete()
      .eq('id', id)
      .eq('family_id', session.familyId)
  }

  if (type === 'village') {
    await supabase
      .from('users')
      .delete()
      .eq('id', id)
      .eq('family_id', session.familyId)
      .neq('id', session.userId) // Can't delete yourself
  }

  return NextResponse.json({ success: true })
}
