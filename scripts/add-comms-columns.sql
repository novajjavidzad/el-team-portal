-- Add full-record columns to core.communications
-- Run in Supabase SQL Editor

ALTER TABLE core.communications
  ADD COLUMN IF NOT EXISTS sender_email     TEXT,
  ADD COLUMN IF NOT EXISTS sender_name      TEXT,
  ADD COLUMN IF NOT EXISTS recipient_emails JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS cc_emails        JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS recording_url    TEXT,
  ADD COLUMN IF NOT EXISTS transcript       TEXT,
  ADD COLUMN IF NOT EXISTS has_attachments  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS attachments_metadata JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS thread_id        TEXT,
  ADD COLUMN IF NOT EXISTS from_number      TEXT,
  ADD COLUMN IF NOT EXISTS to_number        TEXT;

-- Notify PostgREST to reload schema
NOTIFY pgrst, 'reload schema';
