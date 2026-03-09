/**
 * HubSpot → core.communications Sync
 *
 * Phase 1: metadata only (channel, direction, occurred_at, subject, snippet)
 * Phase 2: full body/transcripts (future)
 *
 * Resolution priority:
 *   1. Engagement has deal association → direct case match (deterministic)
 *   2. Contact has exactly 1 active case → auto-attach
 *   3. Contact has multiple cases → closest case by created_at date
 *   4. Unresolvable → needs_review = true, never guessed
 *
 * Usage:
 *   node scripts/sync-hubspot-comms.mjs --deal-id=57785602325
 *   node scripts/sync-hubspot-comms.mjs --deal-ids=57785602325,57782704466
 */

import { createClient } from '@supabase/supabase-js'

const HUBSPOT_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN
const SUPABASE_URL  = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!HUBSPOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing env vars'); process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const coreDb   = supabase.schema('core')

// ─── HubSpot API ───────────────────────────────────────────

async function hs(path) {
  const res = await fetch(`https://api.hubapi.com${path}`, {
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` }
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`HubSpot ${res.status} ${path}: ${text.slice(0, 200)}`)
  }
  return res.json()
}

async function hsPost(path, body) {
  const res = await fetch(`https://api.hubapi.com${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error(`HubSpot POST ${res.status} ${path}`)
  return res.json()
}

// ─── Fetch engagements for a deal ─────────────────────────

async function fetchDealEngagements(dealId) {
  const engagementTypes = ['calls', 'emails', 'communications', 'notes', 'meetings', 'tasks']
  const all = []

  for (const type of engagementTypes) {
    try {
      const assoc = await hs(`/crm/v3/objects/deals/${dealId}/associations/${type}`)
      const ids = (assoc?.results ?? []).map(r => r.id)
      if (!ids.length) continue

      // Fetch in batches of 10 with properties
      const props = getPropsForType(type)
      for (let i = 0; i < ids.length; i += 10) {
        const batch = ids.slice(i, i + 10)
        try {
          const data = await hsPost(`/crm/v3/objects/${type}/batch/read`, {
            properties: props,
            inputs: batch.map(id => ({ id }))
          })
          for (const obj of data.results ?? []) {
            all.push({ type, obj, resolvedByDeal: true })
          }
        } catch (e) {
          console.warn(`  Batch read failed for ${type}: ${e.message}`)
        }
        await delay(100)
      }
    } catch (e) {
      // Association might not exist for this type on this deal — skip
    }
  }

  return all
}

function getPropsForType(type) {
  const base = ['hs_timestamp', 'hs_createdate', 'hs_object_id']
  switch (type) {
    case 'calls':
      return [...base,
        'hs_call_direction', 'hs_call_duration', 'hs_call_disposition', 'hs_call_status',
        'hs_call_title', 'hs_call_body', 'hs_call_summary',
        'hs_call_from_number', 'hs_call_to_number',
        'hs_call_from_number_nickname', 'hs_call_to_number_nickname',
        'hs_call_recording_url', 'hs_call_has_transcript', 'hs_call_transcription_id',
      ]
    case 'emails':
      return [...base,
        'hs_email_direction', 'hs_email_subject', 'hs_email_status',
        'hs_email_text',                              // plain text body
        'hs_email_from_email', 'hs_email_from_firstname', 'hs_email_from_lastname',
        'hs_email_to_email', 'hs_email_to_firstname', 'hs_email_to_lastname',
        'hs_email_cc_email', 'hs_email_bcc_email',
        'hs_email_thread_id', 'hs_email_message_id',
        'hs_attachment_ids', 'hs_email_stripped_attachment_count',
        'hs_email_headers',
      ]
    case 'communications':
      return [...base,
        'hs_communication_channel_type', 'hs_communication_body',
        'hs_communication_logged_from',
        'hs_communication_conversations_thread_id',
      ]
    case 'notes':
      return [...base, 'hs_note_body']
    case 'meetings':
      return [...base,
        'hs_meeting_title', 'hs_meeting_body', 'hs_meeting_outcome',
        'hs_meeting_start_time', 'hs_meeting_end_time',
      ]
    case 'tasks':
      return [...base, 'hs_task_subject', 'hs_task_body', 'hs_task_status', 'hs_task_type']
    default:
      return base
  }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)) }

// Strip HTML tags and decode common entities, collapse whitespace
function stripHtml(raw) {
  if (!raw) return null
  return raw
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 500)
}

// ─── Normalize engagement to comm row ─────────────────────

// ─── Direction inference ───────────────────────────────────

// Known Easy Lemon / RockPoint owned identifiers
const EL_EMAIL_DOMAINS = new Set([
  'easylemon.com',
  'rockpointgrowth.com',
  'rockpointlaw.com',
  'rockpointlawpc.com',
])

const EL_PHONE_NUMBERS = new Set([
  '+18554353666',  // Easy Lemon Intake/Main (855) 435-3666
  '8554353666',
  '18554353666',
])

function isELEmail(email) {
  if (!email) return false
  const domain = email.split('@')[1]?.toLowerCase()
  return EL_EMAIL_DOMAINS.has(domain)
}

function isELPhone(phone) {
  if (!phone) return false
  const digits = phone.replace(/\D/g, '')
  return EL_PHONE_NUMBERS.has('+' + digits) || EL_PHONE_NUMBERS.has(digits)
}

function normalizeDirection(raw) {
  if (!raw) return null
  const v = raw.toLowerCase()
  if (v.includes('inbound')) return 'inbound'
  if (v.includes('outbound')) return 'outbound'
  return 'unknown'
}

// Returns { direction, source } where source is how it was determined
function inferDirection(channel, { hsDirection, senderEmail, recipientEmails, fromNumber, toNumber, loggedFrom }) {
  // 1. HubSpot explicit direction (not unknown)
  const hsResolved = normalizeDirection(hsDirection)
  if (hsResolved && hsResolved !== 'unknown') {
    return { direction: hsResolved, source: 'hubspot' }
  }

  // 2. Email: derive from sender/recipient domains
  if (channel === 'email') {
    if (senderEmail) {
      if (isELEmail(senderEmail)) return { direction: 'outbound', source: 'inferred_sender_domain' }
      // Sender is not EL — check if any recipient is EL (client emailing EL)
      const toEL = (recipientEmails ?? []).some(isELEmail)
      if (toEL) return { direction: 'inbound', source: 'inferred_recipient_domain' }
      // Sender unknown domain, recipient not EL — outbound to client
      return { direction: 'outbound', source: 'inferred_recipient_external' }
    }
  }

  // 3. Call: derive from phone numbers
  if (channel === 'call') {
    if (fromNumber && isELPhone(fromNumber)) return { direction: 'outbound', source: 'inferred_from_number' }
    if (toNumber   && isELPhone(toNumber))   return { direction: 'inbound',  source: 'inferred_to_number' }
  }

  // 4. SMS: derive from logged_from field
  if (channel === 'sms' && loggedFrom) {
    const lf = loggedFrom.toLowerCase()
    if (lf.includes('client') || lf.includes('inbound')) return { direction: 'inbound',  source: 'inferred_logged_from' }
    if (lf.includes('crm') || lf.includes('outbound'))   return { direction: 'outbound', source: 'inferred_logged_from' }
  }

  return { direction: 'unknown', source: 'unresolvable' }
}

function parseEmailAddresses(raw) {
  // HubSpot returns semicolon-separated email strings
  if (!raw) return []
  return raw.split(';').map(s => s.trim()).filter(Boolean)
}

function normalizeEngagement(type, obj, caseId, caseContactId, hubspotContactId, hubspotDealId, resolutionMethod) {
  const p = obj.properties ?? {}
  const engId = String(obj.id)

  let channel = 'other'
  let direction = null
  let directionSource = 'unknown'
  let subject = null
  let snippet = null
  let body = null
  let durationSeconds = null
  let outcome = null
  let occurredAt = p.hs_timestamp ?? p.hs_createdate ?? null
  let senderEmail = null
  let senderName = null
  let recipientEmails = []
  let ccEmails = []
  let recordingUrl = null
  let transcript = null
  let hasAttachments = false
  let attachmentsMetadata = []
  let threadId = null
  let fromNumber = null
  let toNumber = null

  switch (type) {
    case 'calls': {
      channel = 'call'
      ;({ direction, source: directionSource } = inferDirection('call', {
        hsDirection: p.hs_call_direction,
        fromNumber: p.hs_call_from_number,
        toNumber: p.hs_call_to_number,
      }))
      subject = p.hs_call_title ?? null
      durationSeconds = p.hs_call_duration ? Math.round(parseInt(p.hs_call_duration) / 1000) : null
      outcome = p.hs_call_disposition ?? null
      recordingUrl = p.hs_call_recording_url ?? null
      fromNumber = p.hs_call_from_number ?? null
      toNumber = p.hs_call_to_number ?? null

      // Full body: prefer summary (AI-generated), fall back to call body/notes
      const fullBody = p.hs_call_summary ?? p.hs_call_body ?? null
      body = stripHtml(fullBody)
      snippet = body ? body.slice(0, 500) : null

      // Transcript reference
      if (p.hs_call_has_transcript === 'true' && p.hs_call_transcription_id) {
        transcript = `HubSpot transcript ID: ${p.hs_call_transcription_id}`
      }
      break
    }

    case 'emails': {
      channel = 'email'
      // Resolve sender/recipients first so inferDirection can use them
      const fromPartsE = [p.hs_email_from_firstname, p.hs_email_from_lastname].filter(Boolean)
      senderEmail = p.hs_email_from_email ?? null
      senderName = fromPartsE.length ? fromPartsE.join(' ') : null
      recipientEmails = parseEmailAddresses(p.hs_email_to_email)
      ;({ direction, source: directionSource } = inferDirection('email', {
        hsDirection: p.hs_email_direction,
        senderEmail,
        recipientEmails,
      }))
      subject = p.hs_email_subject ?? null
      threadId = p.hs_email_thread_id ?? null

      // CC/BCC
      ccEmails = [
        ...parseEmailAddresses(p.hs_email_cc_email),
        ...parseEmailAddresses(p.hs_email_bcc_email),
      ]

      // Full body — plain text preferred
      body = stripHtml(p.hs_email_text)
      snippet = body ? body.slice(0, 500) : null

      // Attachments
      const attachCount = parseInt(p.hs_email_stripped_attachment_count) || 0
      hasAttachments = attachCount > 0 || !!p.hs_attachment_ids
      if (p.hs_attachment_ids) {
        attachmentsMetadata = p.hs_attachment_ids.split(';').filter(Boolean).map(id => ({ hubspot_file_id: id.trim() }))
      }
      break
    }

    case 'communications': {
      channel = 'sms'
      ;({ direction, source: directionSource } = inferDirection('sms', {
        hsDirection: null,
        loggedFrom: p.hs_communication_logged_from,
      }))
      threadId = p.hs_communication_conversations_thread_id ? String(p.hs_communication_conversations_thread_id) : null
      body = stripHtml(p.hs_communication_body)
      snippet = body ? body.slice(0, 500) : null
      break
    }

    case 'notes': {
      channel = 'note'
      body = stripHtml(p.hs_note_body)
      snippet = body ? body.slice(0, 500) : null
      break
    }

    case 'meetings': {
      channel = 'meeting'
      subject = p.hs_meeting_title ?? null
      outcome = p.hs_meeting_outcome ?? null
      occurredAt = p.hs_meeting_start_time ?? occurredAt
      body = stripHtml(p.hs_meeting_body)
      snippet = body ? body.slice(0, 500) : null
      break
    }

    case 'tasks': {
      channel = 'task'
      subject = p.hs_task_subject ?? null
      outcome = p.hs_task_status ?? null
      body = stripHtml(p.hs_task_body)
      snippet = body ? body.slice(0, 500) : null
      break
    }
  }

  return {
    case_id:               caseId,
    case_contact_id:       caseContactId ?? null,
    hubspot_engagement_id: engId,
    hubspot_contact_id:    hubspotContactId ?? null,
    hubspot_deal_id:       hubspotDealId ?? null,
    channel,
    direction,
    subject,
    snippet,
    body,
    occurred_at:           occurredAt,
    duration_seconds:      durationSeconds,
    outcome,
    sender_email:          senderEmail,
    sender_name:           senderName,
    recipient_emails:      recipientEmails,
    cc_emails:             ccEmails,
    recording_url:         recordingUrl,
    transcript,
    has_attachments:       hasAttachments,
    attachments_metadata:  attachmentsMetadata,
    thread_id:             threadId,
    from_number:           fromNumber,
    to_number:             toNumber,
    source_system:         'hubspot',
    resolution_method:     resolutionMethod,
    needs_review:          false,
    raw_metadata:          { type, properties: p, direction_source: directionSource },
    is_deleted:            false,
    updated_at:            new Date().toISOString(),
  }
}

// ─── Sync contacts for a case ──────────────────────────────

async function syncCaseContacts(caseId, dealId) {
  const assoc = await hs(`/crm/v3/objects/deals/${dealId}/associations/contacts`)
  const contactIds = (assoc?.results ?? []).map(r => r.id)

  if (!contactIds.length) {
    console.log('  No contacts associated with deal')
    return []
  }

  const contactRows = []
  for (let i = 0; i < contactIds.length; i++) {
    const cid = contactIds[i]
    try {
      const contact = await hs(`/crm/v3/objects/contacts/${cid}?properties=firstname,lastname,email,phone`)
      const cp = contact.properties ?? {}
      contactRows.push({
        case_id:             caseId,
        hubspot_contact_id:  cid,
        first_name:          cp.firstname ?? null,
        last_name:           cp.lastname ?? null,
        email:               cp.email ?? null,
        phone:               cp.phone ?? null,
        relationship:        i === 0 ? 'primary' : 'other',
        is_primary:          i === 0,
        is_deleted:          false,
        updated_at:          new Date().toISOString(),
      })
    } catch (e) {
      console.warn(`  Failed to fetch contact ${cid}: ${e.message}`)
    }
    await delay(100)
  }

  if (contactRows.length) {
    const { error } = await coreDb
      .from('case_contacts')
      .upsert(contactRows, { onConflict: 'case_id,hubspot_contact_id' })
    if (error) throw new Error(`case_contacts upsert: ${error.message}`)
    console.log(`  ${contactRows.length} contact(s) synced to case_contacts`)
  }

  return contactRows
}

// ─── Main sync for a single deal ──────────────────────────

async function syncDealComms(dealId) {
  // Look up case
  const { data: caseRow, error: caseErr } = await coreDb
    .from('cases')
    .select('id, hubspot_deal_id, client_first_name, client_last_name')
    .eq('hubspot_deal_id', String(dealId))
    .eq('is_deleted', false)
    .single()

  if (caseErr || !caseRow) {
    console.log(`  Deal ${dealId} not found in core.cases — sync it first`)
    return { ok: 0, err: 0, review: 0 }
  }

  console.log(`  Case: ${caseRow.client_first_name} ${caseRow.client_last_name} (${caseRow.id})`)

  // Sync contacts first
  const contacts = await syncCaseContacts(caseRow.id, dealId)

  // Build contact lookup map: hubspot_contact_id → case_contacts.id
  const { data: ccRows } = await coreDb
    .from('case_contacts')
    .select('id, hubspot_contact_id')
    .eq('case_id', caseRow.id)
  const contactMap = Object.fromEntries((ccRows ?? []).map(r => [r.hubspot_contact_id, r.id]))

  // Fetch all engagements via deal association
  console.log('  Fetching engagements via deal association...')
  const engagements = await fetchDealEngagements(dealId)
  console.log(`  ${engagements.length} engagements found`)

  if (!engagements.length) return { ok: 0, err: 0, review: 0 }

  // Normalize + upsert
  const rows = engagements.map(({ type, obj }) =>
    normalizeEngagement(
      type, obj,
      caseRow.id,
      null, // case_contact_id — would need association lookup per engagement; skip for phase 1
      null, // hubspot_contact_id — deal-level resolution doesn't need it
      String(dealId),
      'deal_association'
    )
  )

  let ok = 0, err = 0, review = 0
  // Upsert in batches
  for (let i = 0; i < rows.length; i += 50) {
    const chunk = rows.slice(i, i + 50)
    const { error } = await coreDb
      .from('communications')
      .upsert(chunk, { onConflict: 'hubspot_engagement_id,source_system' })
    if (error) {
      console.error(`  Upsert error: ${error.message}`)
      err += chunk.length
    } else {
      ok += chunk.length
    }
  }

  return { ok, err, review }
}

// ─── CLI ──────────────────────────────────────────────────

const args = process.argv.slice(2)
const dealId  = args.find(a => a.startsWith('--deal-id='))?.split('=')[1]
const dealIds = args.find(a => a.startsWith('--deal-ids='))?.split('=')[1]?.split(',')

if (!dealId && !dealIds) {
  console.error('Usage: --deal-id=<id>  or  --deal-ids=<id1,id2,...>')
  process.exit(1)
}

const ids = dealId ? [dealId] : dealIds

let totalOk = 0, totalErr = 0, totalReview = 0

for (const id of ids) {
  console.log(`\n▶  Syncing comms for deal: ${id}`)
  console.log('─'.repeat(50))
  try {
    const { ok, err, review } = await syncDealComms(id)
    totalOk += ok; totalErr += err; totalReview += review
    console.log(`  ✅ ${ok} comms synced, ${err} errors, ${review} flagged for review`)
  } catch (e) {
    console.error(`  ❌ ${e.message}`)
    totalErr++
  }
  await delay(200)
}

const { count } = await coreDb.from('communications').select('*', { count: 'exact', head: true })
console.log(`\n${'─'.repeat(50)}`)
console.log(`Total synced: ${totalOk} | Errors: ${totalErr} | Flagged: ${totalReview}`)
console.log(`core.communications total: ${count}`)
