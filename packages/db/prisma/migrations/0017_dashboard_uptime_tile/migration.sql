-- REQ-UI-036 — the overall uptime tile joins the admin and CTO/CIO persona templates (packages/contracts dashboard.ts).
-- Dashboards already created from those templates get the tile in first position so the main dashboard shows it
-- without the owner re-running the wizard; a dashboard that already carries the kind is left alone.
UPDATE "dashboards"
SET "widgets" = jsonb_build_array(jsonb_build_object('id', gen_random_uuid()::text, 'kind', 'services.uptime', 'size', 's', 'options', '{}'::jsonb)) || "widgets"
WHERE "persona" IN ('admin', 'cto_cio')
  AND NOT ("widgets" @> '[{"kind": "services.uptime"}]'::jsonb);
