-- REQ-BSM-003 REQ-UI-013 (ADR-019) — scenario kinds are the conditions the console offers (failed, degraded,
-- power_loss, link_down, certificate_expired, warranty_expired, subscription_expired, end_of_life,
-- vulnerability_exploited, capacity_exhausted, maintenance). The earlier scope kinds (component, power, rack, site,
-- network, storage, cloud_region, shared_service) were never produced by the console, which sent the condition and
-- was rejected; rows that carry one are mapped to the nearest condition.
ALTER TYPE "ScenarioKind" RENAME TO "ScenarioKind_old";
CREATE TYPE "ScenarioKind" AS ENUM (
  'failed',
  'degraded',
  'power_loss',
  'link_down',
  'certificate_expired',
  'warranty_expired',
  'subscription_expired',
  'end_of_life',
  'vulnerability_exploited',
  'capacity_exhausted',
  'maintenance'
);
ALTER TABLE "impact_scenarios"
  ALTER COLUMN "kind" TYPE "ScenarioKind"
  USING (
    CASE "kind"::text
      WHEN 'power' THEN 'power_loss'
      WHEN 'network' THEN 'link_down'
      WHEN 'maintenance' THEN 'maintenance'
      ELSE 'failed'
    END
  )::"ScenarioKind";
DROP TYPE "ScenarioKind_old";
