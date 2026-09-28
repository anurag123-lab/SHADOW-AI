-- =====================================================================
-- Shadow AI Guard — 004 Entropy-based secret detection
-- =====================================================================
-- Adds the `genericSecret` pattern type to the policy engine.
--
-- Prefix rules (sk-, AKIA, ghp_) only find credentials from vendors we
-- thought to list. The entropy rule is the backstop for the ones we did
-- not: an internal service's random token, a rotated key with a new
-- prefix, a generated password.
--
-- It defaults to 'Warn', not 'MandatoryRedaction', because it is a
-- heuristic. A heuristic that cannot be overridden is a heuristic that
-- gets the extension uninstalled. IT can promote it from the dashboard.
--
-- Safe to run more than once.
-- =====================================================================

-- Backfill every existing company.
INSERT INTO public.policies (company_id, pattern_type, tier)
SELECT c.id, 'genericSecret', 'Warn'
FROM public.companies c
ON CONFLICT (company_id, pattern_type) DO NOTHING;

-- And make sure new companies get it too.
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
    (p_company_id, 'customKeyword',          'Warn'),
    (p_company_id, 'genericSecret',          'Warn')
  ON CONFLICT (company_id, pattern_type) DO NOTHING;
$fn$;

-- Verify: should return one row per company, tier = 'Warn'.
-- SELECT company_id, tier FROM policies WHERE pattern_type = 'genericSecret';
