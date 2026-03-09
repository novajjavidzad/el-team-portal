-- Step 1: Add SharePoint columns to core.cases
ALTER TABLE core.cases ADD COLUMN IF NOT EXISTS sharepoint_folder_url TEXT;
ALTER TABLE core.cases ADD COLUMN IF NOT EXISTS sharepoint_folder_title TEXT;

-- Step 2: core.case_documents — document metadata from SharePoint Graph API
CREATE TABLE IF NOT EXISTS core.case_documents (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id              UUID NOT NULL REFERENCES core.cases(id) ON DELETE CASCADE,

  -- SharePoint Graph identity
  sharepoint_item_id   TEXT NOT NULL,
  sharepoint_drive_id  TEXT,

  -- File metadata
  name                 TEXT NOT NULL,
  file_extension       TEXT,
  size_bytes           BIGINT,
  mime_type            TEXT,

  -- URLs
  web_url              TEXT,      -- open in browser
  download_url         TEXT,      -- direct download (short-lived)

  -- Timestamps from SharePoint
  created_at_source    TIMESTAMPTZ,
  modified_at_source   TIMESTAMPTZ,
  created_by           TEXT,
  modified_by          TEXT,

  -- Classification (set manually or by AI later)
  document_type        TEXT,      -- repair_order, invoice, photo, correspondence, contract, other
  tags                 TEXT[],
  is_reviewed          BOOLEAN DEFAULT FALSE,
  review_notes         TEXT,

  -- Sync metadata
  synced_at            TIMESTAMPTZ DEFAULT NOW(),
  is_deleted           BOOLEAN DEFAULT FALSE,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT case_documents_unique UNIQUE (case_id, sharepoint_item_id)
);

CREATE INDEX IF NOT EXISTS idx_case_documents_case_id   ON core.case_documents(case_id);
CREATE INDEX IF NOT EXISTS idx_case_documents_type      ON core.case_documents(document_type);
CREATE INDEX IF NOT EXISTS idx_case_documents_synced_at ON core.case_documents(synced_at);

GRANT ALL    ON core.case_documents TO service_role;
GRANT SELECT ON core.case_documents TO authenticated;

NOTIFY pgrst, 'reload schema';
