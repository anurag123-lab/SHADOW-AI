-- =====================================================================
-- 006 — Team roster: which emails have joined the workspace.
--
-- Admins need to know WHO is enrolled (seat count, offboarding, "did
-- Priya install it yet?"). They must still not be able to tell WHICH
-- anonymous ID belongs to whom — that is the dashboard's core promise.
--
-- So the roster lives in its own table holding email + join time and
-- deliberately NO employee_hash and NO department. employee_profiles
-- (the hash mapping) stays self-only, exactly as before.
--
-- Rows are written only by a SECURITY DEFINER trigger when someone
-- enrols; clients get read access (admins, own company) and nothing else.
--
-- Run in the Supabase SQL editor. Safe to re-run.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.company_members (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  email      TEXT NOT NULL CHECK (length(email) <= 320),
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_company_members_company ON public.company_members(company_id);

ALTER TABLE public.company_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS company_members_select_admin ON public.company_members;
CREATE POLICY company_members_select_admin ON public.company_members
  FOR SELECT USING (public.is_admin() AND company_id = public.current_company_id());

REVOKE INSERT, UPDATE, DELETE ON public.company_members FROM authenticated, anon;
GRANT  SELECT ON public.company_members TO authenticated;

-- Record the email whenever an employee enrols (join_company_as_employee).
CREATE OR REPLACE FUNCTION public.record_company_member()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  INSERT INTO public.company_members (user_id, company_id, email, joined_at)
  SELECT NEW.id, NEW.company_id, u.email, NEW.created_at
  FROM auth.users u WHERE u.id = NEW.id AND u.email IS NOT NULL
  ON CONFLICT (user_id) DO UPDATE
    SET company_id = EXCLUDED.company_id, email = EXCLUDED.email;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_record_company_member ON public.employee_profiles;
CREATE TRIGGER trg_record_company_member
  AFTER INSERT ON public.employee_profiles
  FOR EACH ROW EXECUTE FUNCTION public.record_company_member();

-- Backfill everyone who enrolled before this migration.
INSERT INTO public.company_members (user_id, company_id, email, joined_at)
SELECT ep.id, ep.company_id, u.email, ep.created_at
FROM public.employee_profiles ep
JOIN auth.users u ON u.id = ep.id
WHERE u.email IS NOT NULL
ON CONFLICT (user_id) DO UPDATE
  SET company_id = EXCLUDED.company_id, email = EXCLUDED.email;
