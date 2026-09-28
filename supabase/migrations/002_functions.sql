-- =====================================================================
-- Shadow AI Guard — 002 Functions, Onboarding RPCs, Aggregations
-- =====================================================================
-- All identity-resolution helpers are SECURITY DEFINER so that the RLS
-- policies in 003 can call them without triggering recursive policy
-- evaluation on the profile tables themselves.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Identity helpers
-- ---------------------------------------------------------------------

-- The company of the currently authenticated user, whoever they are.
CREATE OR REPLACE FUNCTION public.current_company_id()
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT company_id FROM public.admin_profiles    WHERE id = auth.uid()
  UNION ALL
  SELECT company_id FROM public.employee_profiles WHERE id = auth.uid()
  LIMIT 1;
$fn$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT EXISTS (SELECT 1 FROM public.admin_profiles WHERE id = auth.uid());
$fn$;

CREATE OR REPLACE FUNCTION public.is_employee()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT EXISTS (SELECT 1 FROM public.employee_profiles WHERE id = auth.uid());
$fn$;

-- The caller's own opaque hash — used by RLS to guarantee an employee
-- can only ever write events attributed to themselves.
CREATE OR REPLACE FUNCTION public.current_employee_hash()
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT employee_hash FROM public.employee_profiles WHERE id = auth.uid();
$fn$;

-- ---------------------------------------------------------------------
-- Opaque identifier generation
-- ---------------------------------------------------------------------
-- Deliberately random, NOT a hash of the email: a hash of an email is
-- reversible by dictionary attack and would re-identify employees.
CREATE OR REPLACE FUNCTION public.generate_employee_hash()
RETURNS TEXT
LANGUAGE sql VOLATILE AS $fn$
  SELECT 'emp_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16);
$fn$;

CREATE OR REPLACE FUNCTION public.generate_join_code()
RETURNS TEXT
LANGUAGE sql VOLATILE AS $fn$
  SELECT upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
$fn$;

-- ---------------------------------------------------------------------
-- Default policy set (Feature 1 tier defaults, Feature 8 overridable)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.seed_default_policies(p_company_id UUID)
RETURNS VOID
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  INSERT INTO public.policies (company_id, pattern_type, tier)
  VALUES
    (p_company_id, 'email',                  'Warn'),
    (p_company_id, 'apiKey',                 'MandatoryRedaction'),
    (p_company_id, 'cardNumber',             'MandatoryRedaction'),
    (p_company_id, 'phone',                  'Warn'),
    (p_company_id, 'awsKey',                 'MandatoryRedaction'),
    (p_company_id, 'ipAddress',              'Warn'),
    (p_company_id, 'healthTerm',             'Warn'),
    (p_company_id, 'privateKey',             'MandatoryRedaction'),
    (p_company_id, 'panCard',                'MandatoryRedaction'),
    (p_company_id, 'ifscCode',               'Warn'),
    (p_company_id, 'gstin',                  'Warn'),
    (p_company_id, 'confidentialityMarker',  'Warn'),
    (p_company_id, 'legalTerm',              'Warn'),
    (p_company_id, 'hrTerm',                 'Warn'),
    (p_company_id, 'corporateStrategyTerm',  'Warn'),
    (p_company_id, 'ipTerm',                 'Warn'),
    (p_company_id, 'customKeyword',          'Warn')
  ON CONFLICT (company_id, pattern_type) DO NOTHING;
$fn$;

-- ---------------------------------------------------------------------
-- Onboarding RPC: admin creates their company on first dashboard login
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_company_and_admin(
  p_company_name TEXT,
  p_notification_email TEXT DEFAULT NULL
)
RETURNS TABLE (company_id UUID, join_code TEXT)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_company_id UUID;
  v_join_code  TEXT;
  v_email      TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- Idempotent: an admin who already has a company just gets it back.
  SELECT ap.company_id INTO v_company_id
  FROM public.admin_profiles ap WHERE ap.id = auth.uid();

  IF v_company_id IS NOT NULL THEN
    SELECT c.join_code INTO v_join_code FROM public.companies c WHERE c.id = v_company_id;
    RETURN QUERY SELECT v_company_id, v_join_code;
    RETURN;
  END IF;

  SELECT COALESCE(p_notification_email, u.email) INTO v_email
  FROM auth.users u WHERE u.id = auth.uid();

  v_join_code := public.generate_join_code();

  INSERT INTO public.companies (name, join_code)
  VALUES (p_company_name, v_join_code)
  RETURNING id INTO v_company_id;

  INSERT INTO public.admin_profiles (id, company_id, role, notification_email)
  VALUES (auth.uid(), v_company_id, 'owner', v_email);

  PERFORM public.seed_default_policies(v_company_id);

  RETURN QUERY SELECT v_company_id, v_join_code;
END;
$fn$;

-- ---------------------------------------------------------------------
-- Onboarding RPC: employee enrolls from the extension using a join code
-- Returns the opaque hash the extension caches and stamps on events.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.join_company_as_employee(
  p_join_code TEXT,
  p_department TEXT DEFAULT 'Unspecified'
)
RETURNS TABLE (company_id UUID, employee_hash TEXT, department TEXT, company_name TEXT, sanctioned_url TEXT, sanctioned_name TEXT)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_company_id UUID;
  v_hash       TEXT;
  v_dept       TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- Already enrolled? Return the existing identity (never re-issue a hash:
  -- a new hash would fork one person's history into two anonymous people).
  SELECT ep.company_id, ep.employee_hash, ep.department
    INTO v_company_id, v_hash, v_dept
  FROM public.employee_profiles ep WHERE ep.id = auth.uid();

  IF v_hash IS NULL THEN
    SELECT c.id INTO v_company_id FROM public.companies c
    WHERE c.join_code = upper(trim(p_join_code));

    IF v_company_id IS NULL THEN
      RAISE EXCEPTION 'invalid join code';
    END IF;

    v_hash := public.generate_employee_hash();
    v_dept := COALESCE(p_department, 'Unspecified');

    INSERT INTO public.employee_profiles (id, company_id, department, employee_hash)
    VALUES (auth.uid(), v_company_id, v_dept, v_hash);
  END IF;

  RETURN QUERY
  SELECT v_company_id, v_hash, v_dept, c.name, c.sanctioned_ai_tool_url, c.sanctioned_ai_tool_name
  FROM public.companies c WHERE c.id = v_company_id;
END;
$fn$;

-- Employee updates their own department (Feature 10)
CREATE OR REPLACE FUNCTION public.set_my_department(p_department TEXT)
RETURNS TEXT
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  UPDATE public.employee_profiles SET department = p_department WHERE id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'not enrolled'; END IF;
  RETURN p_department;
END;
$fn$;

-- ---------------------------------------------------------------------
-- Feature 14 — Override escalation (admin-scoped aggregation)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_repeated_overrides(p_days INT DEFAULT 30)
RETURNS TABLE (employee_hash TEXT, department TEXT, override_count BIGINT, last_override TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT fe.employee_hash,
         max(fe.department)         AS department,
         count(*)                   AS override_count,
         max(fe.timestamp)          AS last_override
  FROM public.flagged_events fe
  JOIN public.companies c ON c.id = fe.company_id
  WHERE fe.company_id = public.current_company_id()
    AND public.is_admin()
    AND fe.action IN ('sent_anyway','uploaded_anyway')
    AND fe.risk_level = 'High'
    AND fe.timestamp > now() - make_interval(days => p_days)
  GROUP BY fe.employee_hash, c.override_alert_threshold
  HAVING count(*) >= max(c.override_alert_threshold)
  ORDER BY count(*) DESC;
$fn$;

-- ---------------------------------------------------------------------
-- Feature 18 — Weekly digest aggregation (used by dashboard + notifier)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_weekly_digest(p_company_id UUID DEFAULT NULL, p_days INT DEFAULT 7)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_company UUID := COALESCE(p_company_id, public.current_company_id());
  v_since   TIMESTAMPTZ := now() - make_interval(days => p_days);
  v_result  JSONB;
BEGIN
  IF v_company IS NULL THEN RAISE EXCEPTION 'no company context'; END IF;

  SELECT jsonb_build_object(
    'companyId',        v_company,
    'periodDays',       p_days,
    'total',            (SELECT count(*) FROM public.flagged_events WHERE company_id = v_company AND timestamp > v_since),
    'mandatoryRedactions', (SELECT count(*) FROM public.flagged_events WHERE company_id = v_company AND timestamp > v_since AND tier = 'MandatoryRedaction'),
    'blockedUploads',   (SELECT count(*) FROM public.flagged_events WHERE company_id = v_company AND timestamp > v_since AND action IN ('blocked','upload_cancelled')),
    'confirmedLeaks',   (SELECT count(*) FROM public.flagged_events WHERE company_id = v_company AND timestamp > v_since AND confirmed_leak),
    'overrides',        (SELECT count(*) FROM public.flagged_events WHERE company_id = v_company AND timestamp > v_since AND action IN ('sent_anyway','uploaded_anyway')),
    'falsePositives',   (SELECT count(*) FROM public.flagged_events WHERE company_id = v_company AND timestamp > v_since AND action = 'marked_false_positive'),
    'topDepartment',    (SELECT department FROM public.flagged_events WHERE company_id = v_company AND timestamp > v_since
                          GROUP BY department ORDER BY count(*) DESC LIMIT 1),
    'topDepartmentCount', (SELECT count(*) FROM public.flagged_events WHERE company_id = v_company AND timestamp > v_since
                          GROUP BY department ORDER BY count(*) DESC LIMIT 1),
    'newToolsCount',    (SELECT count(DISTINCT ai_tool) FROM public.discovered_tools WHERE company_id = v_company AND timestamp > v_since),
    'topPatterns',      (SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM (
                            SELECT pt AS pattern, count(*) AS n
                            FROM public.flagged_events fe, jsonb_array_elements_text(fe.pattern_types) AS pt
                            WHERE fe.company_id = v_company AND fe.timestamp > v_since
                            GROUP BY pt ORDER BY count(*) DESC LIMIT 5) t)
  ) INTO v_result;

  RETURN v_result;
END;
$fn$;

-- ---------------------------------------------------------------------
-- Feature 13 — False-positive rate
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_false_positive_stats()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_company UUID := public.current_company_id();
  v_total   BIGINT;
  v_fp      BIGINT;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'admin only'; END IF;

  SELECT count(*) INTO v_total FROM public.flagged_events WHERE company_id = v_company;
  SELECT count(*) INTO v_fp    FROM public.flagged_events WHERE company_id = v_company AND action = 'marked_false_positive';

  RETURN jsonb_build_object(
    'total', v_total,
    'falsePositives', v_fp,
    'falsePositiveRate', CASE WHEN v_total = 0 THEN 0 ELSE round((v_fp::numeric / v_total) * 100, 1) END,
    'byReason', (SELECT COALESCE(jsonb_object_agg(false_positive_reason, n), '{}'::jsonb) FROM (
        SELECT false_positive_reason, count(*) AS n
        FROM public.flagged_events
        WHERE company_id = v_company AND action = 'marked_false_positive' AND false_positive_reason IS NOT NULL
        GROUP BY false_positive_reason) r)
  );
END;
$fn$;
