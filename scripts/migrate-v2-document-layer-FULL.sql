-- ═══════════════════════════════════════════════════════════════════════════
-- EL Team Portal — Full Document Layer Migration
-- Run once in Supabase SQL Editor (safe to re-run: uses IF NOT EXISTS)
-- Order: document_types → case_document_checklist → case_documents
--        → sharepoint columns on core.cases → schema reload
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. core.document_types ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS core.document_types (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code                TEXT        UNIQUE NOT NULL,
  label               TEXT        NOT NULL,
  description         TEXT,
  is_required_default BOOLEAN     NOT NULL DEFAULT FALSE,
  required_for_stages TEXT[]      NOT NULL DEFAULT '{}',
  sort_order          INTEGER     NOT NULL DEFAULT 0,
  is_active           BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

GRANT ALL    ON core.document_types TO service_role;
GRANT SELECT ON core.document_types TO authenticated;


-- ── 2. Seed document_types (lemon law catalog) ───────────────────────────

INSERT INTO core.document_types
  (code, label, description, is_required_default, required_for_stages, sort_order)
VALUES
  (
    'repair_order',
    'Repair Order(s)',
    'Dealer repair orders documenting work performed on the vehicle',
    TRUE,
    ARRAY['document_collection'],
    1
  ),
  (
    'purchase_agreement',
    'Purchase/Lease Agreement',
    'Original vehicle purchase or lease contract',
    TRUE,
    ARRAY['document_collection'],
    2
  ),
  (
    'warranty_doc',
    'Warranty Documentation',
    'Manufacturer warranty card or coverage documentation',
    TRUE,
    ARRAY['document_collection'],
    3
  ),
  (
    'odometer_disclosure',
    'Odometer Disclosure',
    'Odometer reading disclosure at time of purchase',
    FALSE,
    ARRAY['document_collection'],
    4
  ),
  (
    'dealer_correspondence',
    'Dealer Correspondence',
    'Letters, emails, or written communication with the dealer',
    FALSE,
    ARRAY['document_collection'],
    5
  ),
  (
    'manufacturer_correspondence',
    'Manufacturer Correspondence',
    'Letters, emails, or written communication with the manufacturer',
    FALSE,
    ARRAY['document_collection'],
    6
  ),
  (
    'diagnostic_report',
    'Diagnostic Report',
    'Dealer diagnostic scan or technical report',
    FALSE,
    ARRAY['document_collection'],
    7
  ),
  (
    'loaner_records',
    'Loaner Vehicle Records',
    'Records of loaner vehicle provided during repairs',
    FALSE,
    ARRAY['document_collection'],
    8
  ),
  (
    'payment_records',
    'Repair Payment Records',
    'Receipts or invoices for out-of-pocket repair costs',
    FALSE,
    ARRAY['document_collection'],
    9
  ),
  (
    'client_id',
    'Client ID',
    'Government-issued photo identification',
    FALSE,
    ARRAY['document_collection'],
    10
  ),
  (
    'photos',
    'Photos of Defects',
    'Photographs documenting the vehicle defects',
    FALSE,
    ARRAY['document_collection'],
    11
  ),
  (
    'other',
    'Other',
    'Any other relevant documentation',
    FALSE,
    ARRAY['document_collection'],
    12
  )
ON CONFLICT (code) DO NOTHING;


-- ── 3. core.case_document_checklist ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS core.case_document_checklist (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id            UUID        NOT NULL REFERENCES core.cases(id) ON DELETE CASCADE,
  document_type_code TEXT        NOT NULL REFERENCES core.document_types(code),

  status TEXT NOT NULL DEFAULT 'required',
  CONSTRAINT checklist_status_check CHECK (
    status IN (
      'required',
      'requested',
      'received',
      'under_review',
      'approved',
      'rejected',
      'waived'
    )
  ),

  is_required  BOOLEAN     NOT NULL DEFAULT TRUE,
  requested_at TIMESTAMPTZ,
  received_at  TIMESTAMPTZ,
  approved_at  TIMESTAMPTZ,
  notes        TEXT,

  -- Audit fields
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by   TEXT,
  updated_by   TEXT,
  is_deleted   BOOLEAN     NOT NULL DEFAULT FALSE,

  CONSTRAINT checklist_unique UNIQUE (case_id, document_type_code)
);

CREATE INDEX IF NOT EXISTS idx_checklist_case_id ON core.case_document_checklist(case_id);
CREATE INDEX IF NOT EXISTS idx_checklist_status  ON core.case_document_checklist(status);

GRANT ALL    ON core.case_document_checklist TO service_role;
GRANT SELECT ON core.case_document_checklist TO authenticated;


-- ── 4. core.case_documents ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS core.case_documents (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               UUID        NOT NULL REFERENCES core.cases(id) ON DELETE CASCADE,

  -- Link to checklist (set when file is classified)
  checklist_item_id     UUID        REFERENCES core.case_document_checklist(id),
  document_type_code    TEXT        REFERENCES core.document_types(code),

  -- SharePoint Graph identity
  sharepoint_item_id    TEXT        NOT NULL,
  sharepoint_drive_id   TEXT,

  -- File metadata
  name                  TEXT        NOT NULL,
  file_extension        TEXT,
  size_bytes            BIGINT,
  mime_type             TEXT,

  -- URLs
  web_url               TEXT,
  download_url          TEXT,

  -- Timestamps from SharePoint
  created_at_source     TIMESTAMPTZ,
  modified_at_source    TIMESTAMPTZ,
  created_by            TEXT,
  modified_by           TEXT,

  -- Classification (manual / auto / ai)
  is_classified         BOOLEAN     NOT NULL DEFAULT FALSE,
  classified_by         TEXT,
  classified_at         TIMESTAMPTZ,
  classification_source TEXT,

  -- Document review
  document_type         TEXT,
  tags                  TEXT[],
  is_reviewed           BOOLEAN     NOT NULL DEFAULT FALSE,
  review_notes          TEXT,

  -- Audit fields
  synced_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_deleted            BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT case_documents_unique UNIQUE (case_id, sharepoint_item_id)
);

CREATE INDEX IF NOT EXISTS idx_case_documents_case_id    ON core.case_documents(case_id);
CREATE INDEX IF NOT EXISTS idx_case_documents_type       ON core.case_documents(document_type_code);
CREATE INDEX IF NOT EXISTS idx_case_documents_classified ON core.case_documents(is_classified);
CREATE INDEX IF NOT EXISTS idx_case_documents_synced_at  ON core.case_documents(synced_at);

GRANT ALL    ON core.case_documents TO service_role;
GRANT SELECT ON core.case_documents TO authenticated;


-- ── 5. SharePoint columns on core.cases ──────────────────────────────────

ALTER TABLE core.cases
  ADD COLUMN IF NOT EXISTS sharepoint_folder_url   TEXT,
  ADD COLUMN IF NOT EXISTS sharepoint_folder_title TEXT;


-- ── 6. Reload PostgREST schema cache ─────────────────────────────────────

NOTIFY pgrst, 'reload schema';
