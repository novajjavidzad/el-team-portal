/**
 * HubSpot Property Sync Job
 * Pulls all deal + contact properties from HubSpot and upserts into
 * integration.hubspot_properties
 *
 * Run manually or via cron every 12 hours
 * Usage: node scripts/sync-hubspot-properties.mjs
 */

import { createClient } from '@supabase/supabase-js'

const HUBSPOT_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN
const SUPABASE_URL  = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!HUBSPOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing env vars')
  process.exit(1)
}

const integrationDb = createClient(SUPABASE_URL, SUPABASE_KEY).schema('integration')

async function hs(path) {
  const res = await fetch(`https://api.hubapi.com${path}`, {
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` }
  })
  if (!res.ok) throw new Error(`HubSpot ${res.status}: ${await res.text()}`)
  return res.json()
}

async function fetchProperties(objectType) {
  const data = await hs(`/crm/v3/properties/${objectType}?archived=false`)
  return (data.results ?? []).map(p => ({
    object_type:  objectType === 'deals' ? 'deal' : 'contact',
    property_name: p.name,
    label:         p.label,
    field_type:    p.type,
    group_name:    p.groupName,
    options:       (p.options ?? []).map(o => ({ label: o.label, value: o.value })),
    is_custom:     !p.hubspotDefined,
    is_hidden:     p.hidden ?? false,
    last_synced_at: new Date().toISOString(),
    updated_at:    new Date().toISOString(),
  }))
}

async function main() {
  console.log('▶  Syncing HubSpot properties...')

  // Log sync start
  const { data: logEntry } = await integrationDb
    .from('hubspot_sync_log')
    .insert({ sync_type: 'properties', status: 'running' })
    .select('id')
    .single()

  const logId = logEntry?.id

  try {
    const [dealProps, contactProps] = await Promise.all([
      fetchProperties('deals'),
      fetchProperties('contacts'),
    ])

    const allProps = [...dealProps, ...contactProps]
    console.log(`  Deals: ${dealProps.length} properties`)
    console.log(`  Contacts: ${contactProps.length} properties`)

    // Batch upsert in chunks of 100
    const chunkSize = 100
    let synced = 0
    for (let i = 0; i < allProps.length; i += chunkSize) {
      const chunk = allProps.slice(i, i + chunkSize)
      const { error } = await integrationDb
        .from('hubspot_properties')
        .upsert(chunk, { onConflict: 'object_type,property_name', ignoreDuplicates: false })
      if (error) throw error
      synced += chunk.length
    }

    // Update sync log
    if (logId) {
      await integrationDb
        .from('hubspot_sync_log')
        .update({
          status: 'success',
          records_total: allProps.length,
          records_synced: synced,
          completed_at: new Date().toISOString(),
          metadata: { deal_count: dealProps.length, contact_count: contactProps.length }
        })
        .eq('id', logId)
    }

    console.log(`✅ Done — ${synced} properties synced`)
  } catch (err) {
    if (logId) {
      await integrationDb
        .from('hubspot_sync_log')
        .update({ status: 'error', error_message: err.message, completed_at: new Date().toISOString() })
        .eq('id', logId)
    }
    throw err
  }
}

main().catch(err => { console.error(err); process.exit(1) })
