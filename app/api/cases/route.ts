import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { createClient } from '@supabase/supabase-js'

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const status = searchParams.get('status')
  const search = searchParams.get('search')
  const page   = parseInt(searchParams.get('page') ?? '1')
  const limit  = 25
  const offset = (page - 1) * limit

  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  ).schema('core')

  let query = db
    .from('cases')
    .select('id, hubspot_deal_id, client_first_name, client_last_name, client_email, client_phone, vehicle_year, vehicle_make, vehicle_model, vehicle_mileage, vehicle_is_new, state_jurisdiction, case_status, case_priority, estimated_value, created_at, updated_at', { count: 'exact' })
    .eq('is_deleted', false)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (status) query = query.eq('case_status', status)

  if (search) {
    query = query.or(
      `client_first_name.ilike.%${search}%,client_last_name.ilike.%${search}%,client_email.ilike.%${search}%,vehicle_make.ilike.%${search}%,vehicle_model.ilike.%${search}%,hubspot_deal_id.eq.${search}`
    )
  }

  const { data, count, error } = await query

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Stage counts for filter tabs
  const { data: stageCounts } = await db
    .from('cases')
    .select('case_status')
    .eq('is_deleted', false)

  const counts: Record<string, number> = {}
  for (const r of stageCounts ?? []) {
    counts[r.case_status] = (counts[r.case_status] ?? 0) + 1
  }

  return NextResponse.json({ cases: data ?? [], total: count ?? 0, stageCounts: counts, page, limit })
}
