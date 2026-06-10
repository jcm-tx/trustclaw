// src/lib/portal-auth.ts
import { cookies } from 'next/headers'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export interface PortalSession {
  userId: string
  familyId: string
  name: string
  phoneNumber: string
}

export async function getPortalSession(): Promise<PortalSession | null> {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get('portal_session')?.value
  if (!sessionToken) return null

  const { data: sessionRaw } = await supabase
    .from('portal_tokens')
    .select('phone_number, expires_at, used')
    .eq('token', sessionToken)
    .eq('type', 'session')
    .single()

  if (!sessionRaw) return null
  const session = sessionRaw as { phone_number: string; expires_at: string; used: boolean }

  if (new Date(session.expires_at) < new Date()) return null

  const { data: userRaw } = await supabase
    .from('users')
    .select('id, family_id, name, phone_number')
    .eq('phone_number', session.phone_number)
    .single()

  if (!userRaw) return null
  const user = userRaw as { id: string; family_id: string; name: string; phone_number: string }

  return {
    userId: user.id,
    familyId: user.family_id,
    name: user.name,
    phoneNumber: user.phone_number,
  }
}

export async function clearPortalSession(): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.delete('portal_session')
}
