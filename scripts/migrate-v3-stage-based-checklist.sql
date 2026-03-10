-- ═══════════════════════════════════════════════════════════════════════════
-- EL Team Portal — Stage-Based Checklist Migration
-- Run in Supabase SQL Editor (safe to re-run: uses ON CONFLICT DO UPDATE)
--
-- Changes:
--   1. Add vehicle_registration to core.document_types
--   2. Fix is_required_default — only repair_order is universally required
--   3. Reset all existing checklist rows to is_required = false
--   4. Re-apply stage-based requirements across all cases
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. Add vehicle_registration to core.document_types ───────────────────

INSERT INTO core.document_types
  (code, label, description, is_required_default, required_for_stages, sort_order)
VALUES
  (
    'vehicle_registration',
    'Vehicle Registration',
    'Current vehicle registration document',
    FALSE,
    ARRAY['sign_up'],
    3
  )
ON CONFLICT (code) DO NOTHING;


-- ── 2. Fix is_required_default — only repair_order is universally required

UPDATE core.document_types
SET is_required_default = FALSE,
    updated_at = NOW()
WHERE code IN (
  'purchase_agreement',
  'warranty_doc',
  'vehicle_registration',
  'odometer_disclosure',
  'dealer_correspondence',
  'manufacturer_correspondence',
  'diagnostic_report',
  'loaner_records',
  'payment_records',
  'client_id',
  'photos',
  'other'
);

UPDATE core.document_types
SET is_required_default = TRUE,
    updated_at = NOW()
WHERE code = 'repair_order';


-- ── 3. Reset all existing checklist rows to is_required = false ───────────
--    This undoes the blanket "all required" mistake from the initial init.
--    Stage-based logic below will re-set is_required = true where appropriate.

UPDATE core.case_document_checklist
SET is_required = FALSE,
    updated_at  = NOW();


-- ── 4. Re-apply stage-based requirements ─────────────────────────────────
--
-- Stage groups:
--   pre-sign-up (intake, nurture, document_collection, attorney_review,
--                info_needed, unknown):
--     → repair_order only
--
--   sign_up / retained:
--     → repair_order + purchase_agreement + vehicle_registration
--
--   settled / dropped:
--     → nothing required (case already resolved or closed)
--
-- Logic runs via a JOIN: for each case, find its stage and update the
-- matching checklist rows for that case.

-- Pre-sign-up stages: require repair_order only
UPDATE core.case_document_checklist AS cl
SET is_required = TRUE,
    updated_at  = NOW()
FROM core.cases c
WHERE cl.case_id            = c.id
  AND cl.document_type_code = 'repair_order'
  AND c.case_status IN (
    'intake', 'nurture', 'document_collection',
    'attorney_review', 'info_needed', 'unknown'
  )
  AND cl.is_deleted = FALSE;

-- sign_up / retained: require repair_order + purchase_agreement + vehicle_registration
UPDATE core.case_document_checklist AS cl
SET is_required = TRUE,
    updated_at  = NOW()
FROM core.cases c
WHERE cl.case_id            = c.id
  AND cl.document_type_code IN ('repair_order', 'purchase_agreement', 'vehicle_registration')
  AND c.case_status IN ('sign_up', 'retained')
  AND cl.is_deleted = FALSE;


-- ── 5. Ensure vehicle_registration checklist rows exist for all cases ─────
--    (The old init didn't create this row — insert it now for all cases)

INSERT INTO core.case_document_checklist
  (case_id, document_type_code, status, is_required, created_at, updated_at)
SELECT
  c.id,
  'vehicle_registration',
  'required',
  CASE
    WHEN c.case_status IN ('sign_up', 'retained') THEN TRUE
    ELSE FALSE
  END,
  NOW(),
  NOW()
FROM core.cases c
WHERE c.is_deleted = FALSE
ON CONFLICT (case_id, document_type_code) DO UPDATE
  SET is_required = EXCLUDED.is_required,
      updated_at  = NOW();


-- ── 6. Reload PostgREST schema cache ─────────────────────────────────────

NOTIFY pgrst, 'reload schema';
