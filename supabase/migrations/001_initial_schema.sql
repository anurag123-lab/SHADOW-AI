-- =====================================================================
-- Shadow AI Guard — 001 Initial Schema
-- =====================================================================
-- DESIGN CONSTRAINT (Feature 20, non-negotiable):
-- No table in this schema contains a column capable of storing raw
-- message content or raw file content. This is enforced STRUCTURALLY:
--   * every free-text column is either absent, length-capped to a size
--     that cannot hold a message, or constrained to a closed value set;
--   * the JSONB arrays that carry detection results are constrained so
--     their elements must be short identifiers (pattern type names),
--     not arbitrary-length extracted text.
-- A reviewer holding ONLY this file can verify that claim without
-- trusting any application code.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Helper: proves a jsonb array contains only short text elements.
-- Makes "smuggle the message into pattern_types" structurally impossible.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.jsonb_is_short_text_array(arr JSONB, max_len INT)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT jsonb_typeof(arr) = 'array'
     AND jsonb_array_length(arr) <= 32
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(arr) AS e
       WHERE jsonb_typeof(e) <> 'string' OR length(e #>> '{}') > max_len
     );
$fn$;

COMMENT ON FUNCTION public.jsonb_is_short_text_array IS
  'Feature 20 enforcement: constrains detection-result arrays to short identifiers so raw content cannot be stored in them.';

-- ---------------------------------------------------------------------
-- companies — tenant root
-- ---------------------------------------------------------------------
CREATE TABLE public.companies (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  -- Feature 11: sanctioned internal AI tool employees are redirected to
  sanctioned_ai_tool_url   TEXT CHECK (sanctioned_ai_tool_url IS NULL OR length(sanctioned_ai_tool_url) <= 500),
  sanctioned_ai_tool_name  TEXT CHECK (sanctioned_ai_tool_name IS NULL OR length(sanctioned_ai_tool_name) <= 60),
  -- Employees self-enroll with this code; avoids IT provisioning each user
  join_code                TEXT NOT NULL UNIQUE CHECK (join_code ~ '^[A-Z0-9]{6,12}$'),
  -- Feature 14: configurable override-escalation threshold
  override_alert_threshold INT NOT NULL DEFAULT 3 CHECK (override_alert_threshold BETWEEN 1 AND 100),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- admin_profiles — IT admins (1:1 with auth.users)
-- ---------------------------------------------------------------------
CREATE TABLE public.admin_profiles (
  id                 UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id         UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  role               TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'owner', 'viewer')),
  notification_email TEXT NOT NULL CHECK (length(notification_email) <= 320),
  digest_opt_in      BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_admin_profiles_company ON public.admin_profiles(company_id);

-- ---------------------------------------------------------------------
-- employee_profiles — maps a real auth identity to an OPAQUE hash.
-- The auth system knows who someone is; the event log never does.
-- ---------------------------------------------------------------------
CREATE TABLE public.employee_profiles (
  id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id    UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  department    TEXT NOT NULL DEFAULT 'Unspecified'
                CHECK (department IN ('Engineering','Sales','Marketing','Finance','HR','Legal','Support','Other','Unspecified')),
  employee_hash TEXT NOT NULL UNIQUE CHECK (employee_hash ~ '^emp_[a-f0-9]{16}$'),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_employee_profiles_company ON public.employee_profiles(company_id);

-- ---------------------------------------------------------------------
-- flagged_events — THE event log. Metadata only, by construction.
-- ---------------------------------------------------------------------
CREATE TABLE public.flagged_events (
  id            BIGSERIAL PRIMARY KEY,
  company_id    UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  employee_hash TEXT NOT NULL CHECK (employee_hash ~ '^emp_[a-f0-9]{16}$'),
  timestamp     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- hostname only, e.g. "chatgpt.com" — capped far below message length
  ai_tool       TEXT NOT NULL CHECK (length(ai_tool) BETWEEN 1 AND 253),

  source        TEXT NOT NULL DEFAULT 'text' CHECK (source IN ('text','file')),
  -- File NAME only (capped at filesystem-realistic length). Never file content.
  file_name     TEXT CHECK (file_name IS NULL OR length(file_name) <= 255),
  file_type     TEXT CHECK (file_type IS NULL OR length(file_type) <= 40),

  -- Detection results: arrays of short identifiers, structurally constrained.
  pattern_types         JSONB NOT NULL DEFAULT '[]'::jsonb
                        CHECK (public.jsonb_is_short_text_array(pattern_types, 40)),
  compliance_frameworks JSONB NOT NULL DEFAULT '[]'::jsonb
                        CHECK (public.jsonb_is_short_text_array(compliance_frameworks, 60)),

  department    TEXT NOT NULL DEFAULT 'Unspecified'
                CHECK (department IN ('Engineering','Sales','Marketing','Finance','HR','Legal','Support','Other','Unspecified')),
  risk_level    TEXT NOT NULL CHECK (risk_level IN ('Low','Medium','High')),
  tier          TEXT CHECK (tier IS NULL OR tier IN ('Warn','MandatoryRedaction')),

  -- Closed action vocabulary — cannot be repurposed as a content field.
  action        TEXT NOT NULL CHECK (action IN (
                  'redacted','sent_anyway','marked_false_positive','dismissed_no_action',
                  'blocked','warned','uploaded_anyway','upload_cancelled','redirected_to_sanctioned'
                )),

  -- Feature 13: closed set of reason tags, NOT a free-text comment box.
  false_positive_reason TEXT CHECK (false_positive_reason IS NULL OR false_positive_reason IN (
                  'not_actually_sensitive','test_or_sample_data','already_public_information'
                )),

  -- Feature 3: a honeytoken hit is a confirmed leak, not a probabilistic flag.
  confirmed_leak BOOLEAN NOT NULL DEFAULT false,
  -- Phase 3 notifier bookkeeping
  notified       BOOLEAN NOT NULL DEFAULT false
);

COMMENT ON TABLE public.flagged_events IS
  'Metadata-only event log (Feature 20). Contains NO column able to hold raw message or file content; every text column is closed-vocabulary or length-capped.';

CREATE INDEX idx_events_company_time   ON public.flagged_events(company_id, timestamp DESC);
CREATE INDEX idx_events_company_action ON public.flagged_events(company_id, action);
CREATE INDEX idx_events_company_emp    ON public.flagged_events(company_id, employee_hash);
CREATE INDEX idx_events_unnotified     ON public.flagged_events(notified) WHERE notified = false;

-- ---------------------------------------------------------------------
-- discovered_tools — Feature 15, passive AI-tool visit signals
-- ---------------------------------------------------------------------
CREATE TABLE public.discovered_tools (
  id            BIGSERIAL PRIMARY KEY,
  company_id    UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  employee_hash TEXT NOT NULL CHECK (employee_hash ~ '^emp_[a-f0-9]{16}$'),
  timestamp     TIMESTAMPTZ NOT NULL DEFAULT now(),
  ai_tool       TEXT NOT NULL CHECK (length(ai_tool) BETWEEN 1 AND 253)
);
CREATE INDEX idx_discovered_company_tool ON public.discovered_tools(company_id, ai_tool);

-- ---------------------------------------------------------------------
-- policies — Feature 8, live per-pattern enforcement tier
-- ---------------------------------------------------------------------
CREATE TABLE public.policies (
  company_id   UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  pattern_type TEXT NOT NULL CHECK (length(pattern_type) BETWEEN 1 AND 40),
  tier         TEXT NOT NULL DEFAULT 'Warn' CHECK (tier IN ('Warn','MandatoryRedaction')),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, pattern_type)
);

-- ---------------------------------------------------------------------
-- honeytokens — Feature 3
-- ---------------------------------------------------------------------
CREATE TABLE public.honeytokens (
  id          BIGSERIAL PRIMARY KEY,
  company_id  UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  token       TEXT NOT NULL CHECK (length(token) BETWEEN 4 AND 120),
  description TEXT CHECK (description IS NULL OR length(description) <= 200),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, token)
);

-- ---------------------------------------------------------------------
-- custom_keywords — Feature 9
-- ---------------------------------------------------------------------
CREATE TABLE public.custom_keywords (
  id         BIGSERIAL PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  keyword    TEXT NOT NULL CHECK (length(keyword) BETWEEN 2 AND 80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, keyword)
);
