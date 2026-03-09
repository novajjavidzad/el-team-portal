-- ============================================================
-- INTEGRATION SCHEMA
-- HubSpot property registry + dynamic field mapping
-- Run in Supabase SQL Editor
-- ============================================================

CREATE SCHEMA IF NOT EXISTS integration;

-- ─── HubSpot Properties Registry ────────────────────────────
-- Mirror of all deal + contact properties from HubSpot API
CREATE TABLE IF NOT EXISTS integration.hubspot_properties (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  object_type     TEXT NOT NULL CHECK (object_type IN ('deal', 'contact')),
  property_name   TEXT NOT NULL,              -- HubSpot internal name
  label           TEXT NOT NULL,              -- Human-readable label
  field_type      TEXT NOT NULL,              -- string, number, date, enumeration, bool
  group_name      TEXT,                       -- HubSpot property group
  options         JSONB NOT NULL DEFAULT '[]',-- Enum options [{label, value}]
  is_custom       BOOLEAN NOT NULL DEFAULT FALSE,
  is_hidden       BOOLEAN NOT NULL DEFAULT FALSE,
  last_synced_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (object_type, property_name)
);

CREATE INDEX IF NOT EXISTS idx_hs_props_object_type ON integration.hubspot_properties(object_type);
CREATE INDEX IF NOT EXISTS idx_hs_props_name ON integration.hubspot_properties(property_name);

-- ─── Case Field Mapping ──────────────────────────────────────
-- Maps HubSpot properties → core.cases columns
CREATE TABLE IF NOT EXISTS integration.hubspot_case_field_mapping (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_column     TEXT NOT NULL UNIQUE,       -- core.cases column name
  hs_object_type  TEXT NOT NULL CHECK (hs_object_type IN ('deal', 'contact')),
  hs_property     TEXT NOT NULL,              -- HubSpot property_name
  data_type       TEXT NOT NULL DEFAULT 'string'
                    CHECK (data_type IN ('string','integer','float','boolean','date','datetime')),
  transform       TEXT,                       -- 'uppercase', 'lowercase', 'parseInt', 'parseFloat', 'boolean_new_used'
  fallback_hs_property TEXT,                 -- secondary HubSpot property if primary is null
  fallback_value  TEXT,                       -- static fallback if both null
  is_required     BOOLEAN NOT NULL DEFAULT FALSE,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Sync Log ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS integration.hubspot_sync_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_type       TEXT NOT NULL,              -- 'properties', 'cases_backfill', 'cases_single', 'cases_webhook'
  status          TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','success','error')),
  records_total   INTEGER DEFAULT 0,
  records_synced  INTEGER DEFAULT 0,
  records_failed  INTEGER DEFAULT 0,
  error_message   TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}',
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_hs_sync_log_type ON integration.hubspot_sync_log(sync_type, started_at DESC);

-- ─── Grants ──────────────────────────────────────────────────
GRANT USAGE ON SCHEMA integration TO service_role, authenticated, anon;
GRANT ALL ON ALL TABLES IN SCHEMA integration TO service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA integration TO authenticated, anon;

-- ─── Seed: correct field mappings from verified matrix ───────
INSERT INTO integration.hubspot_case_field_mapping
  (case_column, hs_object_type, hs_property, data_type, transform, fallback_hs_property, fallback_value, is_required, notes)
VALUES
  ('hubspot_deal_id',        'deal',    'hs_object_id',                                    'string',   NULL,                    NULL,    NULL,    TRUE,  'Deal primary key'),
  ('client_first_name',      'contact', 'firstname',                                       'string',   NULL,                    NULL,    NULL,    TRUE,  NULL),
  ('client_last_name',       'contact', 'lastname',                                        'string',   NULL,                    NULL,    NULL,    TRUE,  NULL),
  ('client_email',           'contact', 'email',                                           'string',   'lowercase',             NULL,    NULL,    FALSE, NULL),
  ('client_phone',           'contact', 'phone',                                           'string',   NULL,                    'mobilephone', NULL, FALSE, 'Fallback to mobile'),
  ('vehicle_year',           'deal',    'vehicle_year',                                    'integer',  'parseInt',              'what_is_the_approximate_year_of_your_vehicle_', NULL, FALSE, 'Two sources - vehicle_year preferred'),
  ('vehicle_make',           'deal',    'vehicle_make',                                    'string',   NULL,                    'what_is_the_make_of_your_vehicle_', NULL, FALSE, NULL),
  ('vehicle_model',          'deal',    'vehicle_model',                                   'string',   NULL,                    'what_is_the_model_of_your_vehicle_', NULL, FALSE, NULL),
  ('vehicle_vin',            'deal',    'vin',                                             'string',   'uppercase',             NULL,    NULL,    FALSE, NULL),
  ('vehicle_mileage',        'deal',    'what_is_the_mileage_of_your_vehicle_',            'integer',  'parseInt',              'mileage_at_first_repair', NULL, FALSE, NULL),
  ('vehicle_purchase_price', 'deal',    'purchase_price',                                  'float',    'parseFloat',            'purchase__lease_agreement_amount', NULL, FALSE, NULL),
  ('vehicle_purchase_date',  'deal',    'purchase__lease_date',                            'date',     NULL,                    'when_did_you_purchase_or_lease_your_vehicle_', NULL, FALSE, NULL),
  ('vehicle_is_new',         'deal',    'was_it_purchased_or_leased_new_or_used_',         'boolean',  'boolean_new_used',      'did_you_purchase_or_lease_your_car_', NULL, FALSE, NULL),
  ('state_jurisdiction',     'deal',    'which_state_did_you_purchase_or_lease_your_vehicle_', 'string', NULL,                 NULL,    NULL,    FALSE, 'Falls back to contact.state in code'),
  ('case_status',            'deal',    'dealstage',                                       'string',   'stage_map',             NULL,    'unknown', TRUE, 'Uses STAGE_MAP lookup'),
  ('case_type',              'deal',    NULL,                                              'string',   NULL,                    NULL,    'lemon_law', FALSE, 'Hardcoded for now'),
  ('case_priority',          'deal',    NULL,                                              'string',   NULL,                    NULL,    'normal', FALSE, 'Hardcoded for now'),
  ('estimated_value',        'deal',    'amount',                                          'float',    'parseFloat',            NULL,    NULL,    FALSE, NULL),
  ('created_at',             'deal',    'createdate',                                      'datetime', NULL,                    NULL,    NULL,    TRUE,  NULL),
  ('closed_at',              'deal',    'closedate',                                       'datetime', 'only_if_closed',        NULL,    NULL,    FALSE, 'Only set for settled/dropped stages')
ON CONFLICT (case_column) DO UPDATE SET
  hs_object_type = EXCLUDED.hs_object_type,
  hs_property = EXCLUDED.hs_property,
  data_type = EXCLUDED.data_type,
  transform = EXCLUDED.transform,
  fallback_hs_property = EXCLUDED.fallback_hs_property,
  fallback_value = EXCLUDED.fallback_value,
  is_required = EXCLUDED.is_required,
  notes = EXCLUDED.notes,
  updated_at = NOW();
