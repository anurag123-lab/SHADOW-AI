-- =====================================================================
-- 007 — Live push for ALL detection config, not just policies.
--
-- Before: only `policies` was in the realtime publication, so a keyword,
-- honeytoken or approved-tool change made in the dashboard reached the
-- extension only on its 10-minute fallback poll. Now every config table
-- pushes a change the moment it is saved.
--
-- Realtime respects row-level security: an employee's browser only
-- receives rows it could already SELECT (its own company's config).
-- The extension re-fetches its config on any change notification, so no
-- row content is relied on from the push itself.
--
-- Run in the Supabase SQL editor. Safe to re-run.
-- =====================================================================
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['honeytokens', 'custom_keywords', 'companies'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;
