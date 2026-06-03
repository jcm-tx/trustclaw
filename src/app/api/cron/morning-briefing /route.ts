// src/app/api/cron/morning-briefing/route.ts
import { NextResponse } from 'next/server'

export async function GET() {
  return new NextResponse('Morning briefing route is alive', { status: 200 })
}
