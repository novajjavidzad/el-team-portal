/**
 * Aloware SMS payload parser.
 *
 * Converts a confirmed real Aloware webhook payload into a core.communications
 * insert row. Direction mapping, thread grouping, and case resolution are all
 * derived from the confirmed production payload shape captured 2026-03-10.
 *
 * Outbound direction (direction=2) is wired but marked pending — field mapping
 * will be verified against a real outbound payload before enabling.
 */

export interface AlowareBody {
  id:              number          // communication ID — idempotency key
  body:            string          // full SMS text
  direction:       number          // 1=inbound, 2=outbound (outbound pending confirmation)
  type:            number          // 2=SMS
  created_at:      string          // "YYYY-MM-DD HH:MM:SS" UTC
  contact_id:      number          // Aloware contact ID
  campaign_id:     number          // line/campaign ID
  lead_number:     string          // client E.164 phone
  incoming_number: string          // EL E.164 line
  contact: {
    id:            number
    first_name:    string | null
    last_name:     string | null
    phone_number:  string | null
    uuid_v4:       string | null
  }
  current_status?: string
  disposition_status?: string
  user_id?:        number | null
  user?:           unknown
  [key: string]:   unknown
}

export interface AlowareWebhookPayload {
  event: string    // e.g. "InboundSMS-DispositionCompleted"
  body:  AlowareBody
}

// ── Direction ─────────────────────────────────────────────────────────────

export type Direction = 'inbound' | 'outbound' | 'unknown'

export function parseDirection(direction: number): Direction {
  if (direction === 1) return 'inbound'
  if (direction === 2) return 'outbound'  // pending outbound payload confirmation
  return 'unknown'
}

// ── Thread ID ─────────────────────────────────────────────────────────────
// Derived key — groups all SMS between the same Aloware contact and EL line.
// No native conversation_id in Aloware payload (confirmed from real capture).

export function deriveThreadId(contactId: number, campaignId: number): string {
  return `aloware:${contactId}:${campaignId}`
}

// ── Phone normalisation ───────────────────────────────────────────────────
// Aloware sends E.164 already (+13107201619). Normalise defensively.

export function normalisePhone(phone: string | null | undefined): string | null {
  if (!phone) return null
  const digits = phone.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`
  if (phone.startsWith('+')) return phone
  return phone
}

// ── Snippet ───────────────────────────────────────────────────────────────

export function makeSnippet(body: string, maxLen = 500): string {
  if (!body) return ''
  const clean = body.replace(/\s+/g, ' ').trim()
  return clean.length <= maxLen ? clean : clean.slice(0, maxLen - 1) + '…'
}

// ── Occurred at ───────────────────────────────────────────────────────────
// Aloware sends "YYYY-MM-DD HH:MM:SS" without timezone — it's UTC.

export function parseOccurredAt(createdAt: string): string {
  const iso = createdAt.replace(' ', 'T') + 'Z'
  const d   = new Date(iso)
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString()
}

// ── Is SMS event ──────────────────────────────────────────────────────────
// Accept any Aloware event that carries an SMS payload.
// body.type === 2 is SMS; event name check is a belt-and-suspenders guard.

export function isSmsEvent(payload: AlowareWebhookPayload): boolean {
  const isSmsByType  = payload.body?.type === 2
  const isSmsByEvent = /sms/i.test(payload.event ?? '')
  return isSmsByType || isSmsByEvent
}

// ── Validate inbound SMS ──────────────────────────────────────────────────

export interface ValidationResult {
  valid:  boolean
  reason: string | null
}

export function validateInbound(payload: AlowareWebhookPayload): ValidationResult {
  if (!isSmsEvent(payload)) return { valid: false, reason: 'not_sms_event' }
  if (!payload.body?.id)    return { valid: false, reason: 'missing_communication_id' }
  if (!payload.body?.body)  return { valid: false, reason: 'empty_body' }
  if (parseDirection(payload.body.direction) !== 'inbound') {
    return { valid: false, reason: 'not_inbound' }
  }
  if (!payload.body?.lead_number)     return { valid: false, reason: 'missing_lead_number' }
  if (!payload.body?.incoming_number) return { valid: false, reason: 'missing_incoming_number' }
  return { valid: true, reason: null }
}
