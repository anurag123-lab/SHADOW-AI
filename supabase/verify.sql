-- =====================================================================
-- Shadow AI Guard — migration verification
-- =====================================================================
-- IMPORTANT: Supabase's SQL editor only shows the result of the LAST
-- statement in a script. Run ONE block at a time (select the block, then
-- press Run) — otherwise you only ever see the bottom query's output.
--
-- Block A is the one that matters. Run it first.
-- =====================================================================


-- =====================================================================
-- BLOCK A — full status in a single result set
--
-- Every row should read PASS. Anything else names the fix.
-- =====================================================================
WITH expected(ord, check_name, expected_value, actual_value, fix) AS (
  SELECT
    1,
    'Tables created (001)',
    '8',
    (SELECT count(*)::text
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND c.relname IN ('companies','admin_profiles','employee_profiles','flagged_events',
                          'discovered_tools','policies','honeytokens','custom_keywords')),
    'Run 001_initial_schema.sql'

  UNION ALL SELECT
    2,
    'Functions created (001+002)',
    '14',
    (SELECT count(*)::text
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN ('jsonb_is_short_text_array','current_company_id','is_admin',
                          'is_employee','current_employee_hash','generate_employee_hash',
                          'generate_join_code','seed_default_policies','create_company_and_admin',
                          'join_company_as_employee','set_my_department','get_repeated_overrides',
                          'get_weekly_digest','get_false_positive_stats')),
    'Run 002_functions.sql — must come BEFORE 003'

  UNION ALL SELECT
    3,
    'RLS enabled on all tables',
    '8',
    (SELECT count(*)::text
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
        AND c.relname IN ('companies','admin_profiles','employee_profiles','flagged_events',
                          'discovered_tools','policies','honeytokens','custom_keywords')),
    'Run 003_row_level_security.sql'

  UNION ALL SELECT
    4,
    'RLS policies present (2 per table)',
    '16',
    (SELECT count(*)::text
       FROM pg_policy p
       JOIN pg_class c ON c.oid = p.polrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('companies','admin_profiles','employee_profiles','flagged_events',
                          'discovered_tools','policies','honeytokens','custom_keywords')),
    'Run 003. RLS on with 0 policies = every table locked (safe, but nothing works)'

  UNION ALL SELECT
    5,
    'Privacy constraint on flagged_events',
    '2',
    (SELECT count(*)::text
       FROM pg_constraint
      WHERE conrelid = to_regclass('public.flagged_events')
        AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%jsonb_is_short_text_array%'),
    'Feature 20 is NOT enforced. Re-run 001'

  UNION ALL SELECT
    6,
    'Realtime push on policies',
    '1',
    (SELECT count(*)::text
       FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND tablename = 'policies'),
    'Optional — without it the extension falls back to a 10-minute poll'
)
SELECT
  ord                                                        AS "#",
  check_name                                                 AS "check",
  expected_value                                             AS "expected",
  actual_value                                               AS "actual",
  CASE WHEN actual_value = expected_value THEN 'PASS' ELSE 'FAIL' END AS "status",
  CASE WHEN actual_value = expected_value THEN '' ELSE fix END       AS "how to fix"
FROM expected
ORDER BY ord;


-- =====================================================================
-- BLOCK B — per-table detail (run separately if Block A shows a FAIL)
--
-- policy_count of 0 with rls_enabled = true means that table is locked.
-- A count ABOVE 2 means an extra policy exists — likely auto-created by
-- the dashboard. Not harmful (policies are OR'd), but worth a look.
-- =====================================================================
SELECT
  c.relname        AS table_name,
  c.relrowsecurity AS rls_enabled,
  count(p.polname) AS policy_count,
  2                AS expected,
  string_agg(p.polname::text, ', ' ORDER BY p.polname) AS policy_names
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_policy p ON p.polrelid = c.oid
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relname IN ('companies','admin_profiles','employee_profiles','flagged_events',
                    'discovered_tools','policies','honeytokens','custom_keywords')
GROUP BY c.relname, c.relrowsecurity
ORDER BY c.relname;


-- =====================================================================
-- BLOCK C — your company and join code (after dashboard signup)
--
-- policy_count should be 17: seed_default_policies() runs on signup.
-- Zero rows just means you haven't created an admin account yet.
-- =====================================================================
SELECT
  c.id,
  c.name,
  c.join_code,
  (SELECT count(*) FROM policies        WHERE company_id = c.id) AS policies,
  (SELECT count(*) FROM honeytokens     WHERE company_id = c.id) AS honeytokens,
  (SELECT count(*) FROM custom_keywords WHERE company_id = c.id) AS keywords,
  (SELECT count(*) FROM flagged_events  WHERE company_id = c.id) AS events
FROM companies c
ORDER BY c.created_at;


-- =====================================================================
-- BLOCK D — THE PRIVACY PROOF. This insert MUST fail.
--
-- Run it on stage. It tries to smuggle a message into pattern_types.
--
-- EXPECT: ERROR — violates check constraint
--                 "flagged_events_pattern_types_check"
--
-- That error IS Feature 20. If this insert succeeds, the privacy claim
-- is not true. Uses a real company id so it fails on the CONSTRAINT and
-- not on the foreign key — which is the error you want judges to see.
-- =====================================================================
-- INSERT INTO flagged_events
--   (company_id, employee_hash, ai_tool, risk_level, action, pattern_types)
-- SELECT
--   c.id, 'emp_0123456789abcdef', 'chatgpt.com', 'High', 'redacted',
--   '["my card number is 4111 1111 1111 1111 and my PAN is ABCDE1234F"]'::jsonb
-- FROM companies c LIMIT 1;
