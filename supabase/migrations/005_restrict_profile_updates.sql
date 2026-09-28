-- =====================================================================
-- 005 — Column-level limits on what a signed-in user may UPDATE.
--
-- Row-level security decides WHICH rows a user can update; it says
-- nothing about WHICH COLUMNS. Before this migration:
--
--   admin_profiles_update_self only checks id = auth.uid(), so an admin
--   could PATCH their own row with a different company_id (joining any
--   company whose UUID they learned) or role = 'owner'.
--
--   companies_update_admin let an admin rewrite join_code or
--   override_alert_threshold directly from the browser.
--
-- The dashboard only ever edits the columns granted below. Rows are
-- created by SECURITY DEFINER functions (create_company_and_admin,
-- join_company_as_employee), which these grants do not affect, and the
-- notifier uses the service_role key, which bypasses them.
--
-- Run in the Supabase SQL editor. Safe to re-run.
-- =====================================================================

REVOKE UPDATE ON public.admin_profiles FROM authenticated, anon;
GRANT  UPDATE (notification_email, digest_opt_in) ON public.admin_profiles TO authenticated;

REVOKE UPDATE ON public.companies FROM authenticated, anon;
GRANT  UPDATE (name, sanctioned_ai_tool_name, sanctioned_ai_tool_url) ON public.companies TO authenticated;
