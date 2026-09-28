-- =====================================================================
-- Shadow AI Guard — 003 Row Level Security
-- =====================================================================
-- Threat model this file defends against:
--   1. Company A reading Company B's data (multi-tenant isolation).
--   2. An employee reading their colleagues' events (surveillance creep).
--   3. An employee forging events attributed to another employee_hash.
--   4. An employee silently disabling policy (writing to `policies`).
--   5. An ADMIN de-anonymising the event log by reading the
--      auth.uid -> employee_hash mapping. Admins are intentionally
--      denied SELECT on employee_profiles: the product's privacy claim
--      is only credible if IT itself cannot perform the join.
-- Anything the notifier needs beyond this runs under the service_role
-- key, which bypasses RLS by design and never ships to a client.
-- =====================================================================

ALTER TABLE public.companies          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_profiles     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_profiles  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flagged_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discovered_tools   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.policies           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.honeytokens        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_keywords    ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- companies
-- ---------------------------------------------------------------------
CREATE POLICY companies_select_own ON public.companies
  FOR SELECT USING (id = public.current_company_id());

CREATE POLICY companies_update_admin ON public.companies
  FOR UPDATE USING (id = public.current_company_id() AND public.is_admin())
  WITH CHECK (id = public.current_company_id() AND public.is_admin());

-- ---------------------------------------------------------------------
-- admin_profiles — a user may see and edit only their own row
-- ---------------------------------------------------------------------
CREATE POLICY admin_profiles_select_self ON public.admin_profiles
  FOR SELECT USING (id = auth.uid());

CREATE POLICY admin_profiles_update_self ON public.admin_profiles
  FOR UPDATE USING (id = auth.uid()) WITH CHECK (id = auth.uid());

-- ---------------------------------------------------------------------
-- employee_profiles — SELF ONLY. Deliberately no admin read policy:
-- this is the table that would let IT map a hash back to a person.
-- ---------------------------------------------------------------------
CREATE POLICY employee_profiles_select_self ON public.employee_profiles
  FOR SELECT USING (id = auth.uid());

CREATE POLICY employee_profiles_update_self ON public.employee_profiles
  FOR UPDATE USING (id = auth.uid()) WITH CHECK (id = auth.uid());

-- ---------------------------------------------------------------------
-- flagged_events
--   employees: INSERT only, only for their own company AND own hash
--   admins:    SELECT only, only their own company
--   nobody:    UPDATE or DELETE (the log is append-only to clients)
-- ---------------------------------------------------------------------
CREATE POLICY events_insert_own ON public.flagged_events
  FOR INSERT WITH CHECK (
    public.is_employee()
    AND company_id    = public.current_company_id()
    AND employee_hash = public.current_employee_hash()
  );

CREATE POLICY events_select_admin ON public.flagged_events
  FOR SELECT USING (public.is_admin() AND company_id = public.current_company_id());

-- ---------------------------------------------------------------------
-- discovered_tools — same shape as flagged_events
-- ---------------------------------------------------------------------
CREATE POLICY discovered_insert_own ON public.discovered_tools
  FOR INSERT WITH CHECK (
    public.is_employee()
    AND company_id    = public.current_company_id()
    AND employee_hash = public.current_employee_hash()
  );

CREATE POLICY discovered_select_admin ON public.discovered_tools
  FOR SELECT USING (public.is_admin() AND company_id = public.current_company_id());

-- ---------------------------------------------------------------------
-- policies — employees READ (needed for local tier resolution),
--            admins READ/WRITE. An employee cannot weaken enforcement.
-- ---------------------------------------------------------------------
CREATE POLICY policies_select_members ON public.policies
  FOR SELECT USING (company_id = public.current_company_id());

CREATE POLICY policies_write_admin ON public.policies
  FOR ALL USING (company_id = public.current_company_id() AND public.is_admin())
  WITH CHECK (company_id = public.current_company_id() AND public.is_admin());

-- ---------------------------------------------------------------------
-- honeytokens — employees READ (detection is local, so the client must
-- hold the literals; documented tradeoff), admins READ/WRITE.
-- ---------------------------------------------------------------------
CREATE POLICY honeytokens_select_members ON public.honeytokens
  FOR SELECT USING (company_id = public.current_company_id());

CREATE POLICY honeytokens_write_admin ON public.honeytokens
  FOR ALL USING (company_id = public.current_company_id() AND public.is_admin())
  WITH CHECK (company_id = public.current_company_id() AND public.is_admin());

-- ---------------------------------------------------------------------
-- custom_keywords
-- ---------------------------------------------------------------------
CREATE POLICY keywords_select_members ON public.custom_keywords
  FOR SELECT USING (company_id = public.current_company_id());

CREATE POLICY keywords_write_admin ON public.custom_keywords
  FOR ALL USING (company_id = public.current_company_id() AND public.is_admin())
  WITH CHECK (company_id = public.current_company_id() AND public.is_admin());

-- ---------------------------------------------------------------------
-- Function execution grants
-- ---------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.create_company_and_admin(TEXT, TEXT)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.join_company_as_employee(TEXT, TEXT)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_my_department(TEXT)                TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_repeated_overrides(INT)            TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_weekly_digest(UUID, INT)           TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_false_positive_stats()             TO authenticated;

-- Realtime (Feature 8 live push): publish policy changes to subscribers.
ALTER PUBLICATION supabase_realtime ADD TABLE public.policies;
