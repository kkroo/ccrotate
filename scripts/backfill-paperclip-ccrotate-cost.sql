-- Backfill: price historical operator/devbox pool usage at API-equivalent rates.
--
-- Context: ccrotate-serve's cost-report.js historically wrote operator/devbox
-- CLI usage to paperclip cost_events with biller='ccrotate',
-- billing_type='subscription_included', cost_cents=0. As of the metered-pricing
-- change (lib/serve/cost-report.js modelRateUsd/priceCents, env
-- CCROTATE_PAPERCLIP_COST_METERED default on), NEW rows are written as
-- metered_api with a computed cost. This script back-dates the existing
-- subscription rows to match.
--
-- The rate CASE below MUST stay in sync with modelRateUsd() in
-- lib/serve/cost-report.js. Per-1M-token USD: opus 5/25, sonnet 3/15,
-- haiku 1/5, gpt-5.5 5/30; cache-read = 0.1x base input.
--
-- Fidelity note: cache_creation (write) tokens were never persisted (the
-- adapter + cost-report drop them), so cache-heavy history is a slight
-- UNDER-estimate. Forward Claude runs priced by the CLI's total_cost_usd are
-- exact; these rows and forward Codex are token-derived approximations.
--
-- Provider input semantics (mirrors cost-report.js):
--   anthropic /v1/messages : input_tokens EXCLUDES cache reads
--   openai    /v1/responses: input_tokens INCLUDES the cached subset (subtract)
--
-- Usage:
--   kubectl -n paperclip exec -i paperclip-pg-0 -- \
--     psql -U paperclip -d paperclip -v ON_ERROR_STOP=1 -f - < this_file
-- Section A (preview) is read-only. Section B (apply) is wrapped in a
-- transaction that ROLLS BACK by default — flip to COMMIT to persist.

-- Session-scoped pricing function (single source of truth for both sections).
CREATE OR REPLACE FUNCTION pg_temp.ccrotate_cost_cents(
  p_provider text, p_model text,
  p_in bigint, p_cached bigint, p_out bigint
) RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    -- OpenAI: input_tokens INCLUDES the cached subset -> bill (input - cached).
    WHEN (p_provider = 'openai' OR p_model ~* '^(gpt|o[0-9]|chatgpt)')
         AND p_model ~* 'gpt-5\.5'
      THEN round((greatest(p_in - p_cached, 0) * 5.0 + p_cached * 0.5 + p_out * 30.0) / 1e6 * 100)::bigint
    -- Anthropic families: input_tokens EXCLUDES cache reads.
    WHEN p_provider = 'anthropic' AND p_model ~* 'opus'
      THEN round((p_in * 5.0 + p_cached * 0.5 + p_out * 25.0) / 1e6 * 100)::bigint
    WHEN p_provider = 'anthropic' AND p_model ~* 'sonnet'
      THEN round((p_in * 3.0 + p_cached * 0.3 + p_out * 15.0) / 1e6 * 100)::bigint
    WHEN p_provider = 'anthropic' AND p_model ~* 'haiku'
      THEN round((p_in * 1.0 + p_cached * 0.1 + p_out * 5.0) / 1e6 * 100)::bigint
    ELSE NULL  -- unknown model: leave as subscription_included / 0c
  END
$$;

-- ── Section A: PREVIEW (read-only) ──────────────────────────────────────────
\echo '== Projected metered cost for biller=ccrotate subscription rows =='
SELECT
  provider,
  model,
  count(*)                                                       AS rows,
  sum(cost_cents)                                               AS cur_cents,
  sum(pg_temp.ccrotate_cost_cents(provider, model, input_tokens, cached_input_tokens, output_tokens)) AS proj_cents,
  round(sum(pg_temp.ccrotate_cost_cents(provider, model, input_tokens, cached_input_tokens, output_tokens)) / 100.0, 2) AS proj_usd,
  count(*) FILTER (
    WHERE pg_temp.ccrotate_cost_cents(provider, model, input_tokens, cached_input_tokens, output_tokens) IS NULL
  )                                                              AS unpriced_rows
FROM cost_events
WHERE biller = 'ccrotate'
  AND billing_type = 'subscription_included'
  AND cost_cents = 0
GROUP BY provider, model
ORDER BY proj_cents DESC NULLS LAST;

\echo '== Grand total (USD) that would be booked =='
SELECT round(sum(pg_temp.ccrotate_cost_cents(provider, model, input_tokens, cached_input_tokens, output_tokens)) / 100.0, 2) AS total_usd,
       count(*) AS priced_rows
FROM cost_events
WHERE biller = 'ccrotate'
  AND billing_type = 'subscription_included'
  AND cost_cents = 0
  AND pg_temp.ccrotate_cost_cents(provider, model, input_tokens, cached_input_tokens, output_tokens) IS NOT NULL;

-- ── Section B: APPLY (transactional; ROLLBACK by default) ───────────────────
-- Review Section A output first. To persist, change ROLLBACK -> COMMIT below.
BEGIN;

UPDATE cost_events
SET cost_cents   = pg_temp.ccrotate_cost_cents(provider, model, input_tokens, cached_input_tokens, output_tokens),
    billing_type = 'metered_api'
WHERE biller = 'ccrotate'
  AND billing_type = 'subscription_included'
  AND cost_cents = 0
  AND pg_temp.ccrotate_cost_cents(provider, model, input_tokens, cached_input_tokens, output_tokens) IS NOT NULL;

\echo '== Rows updated (above). ROLLBACK by default — edit to COMMIT to persist. =='
ROLLBACK;

-- ── Revert (if needed after a COMMIT) ───────────────────────────────────────
-- UPDATE cost_events SET cost_cents = 0, billing_type = 'subscription_included'
-- WHERE biller = 'ccrotate' AND billing_type = 'metered_api';
