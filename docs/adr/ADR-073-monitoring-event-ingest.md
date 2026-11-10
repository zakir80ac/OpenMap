# ADR-073 — Monitoring event ingest: Alertmanager, Zabbix, Nagios, Datadog, SolarWinds and Splunk alerts on CI health

Status: Accepted · Date: 2026-11-10 · Tracker: REQ-INT-012 · Contracts: GraphQL 1.45.0 (event contract unchanged)

## Context

CAPABILITY-MAP.md lists monitoring integrations (Zabbix, Nagios, Prometheus, Datadog, SolarWinds, Splunk) for event
ingest and CI enrichment, at parity with Device42. The integration catalogue already named the vendors
(`integration.ts`), but nothing received their alerts. CI health came only from what collectors observed
(`deriveHealth`), so a host that Alertmanager reports as down still showed healthy until the next sweep went stale.

## Decision

1. **One inbound endpoint per integration.** `POST /ingest/monitoring/<integrationId>` (`MONITORING.ingestPath`)
   takes the tool's own payload. Only an enabled, inbound or bidirectional integration of category `monitoring` with a
   monitoring vendor answers. Anything else gets a 404, so nobody can probe which integrations exist. The endpoint
   skips the bearer-token guard. The integration's own credential authenticates the request instead.
2. **Credentials only in OpenBao.** The integration's `credentialRef` names a KV record. The request must present one
   of the values it holds:
   - `token` as a bearer token (Alertmanager `http_config.authorization`, a Zabbix media type header, Datadog custom
     headers);
   - `username` and `password` as basic credentials (SolarWinds Orion's HTTP action);
   - `signingSecret` as `x-openmap-signature: v1=<hex HMAC-SHA256 of "<timestamp>.<raw body>">` with
     `x-openmap-timestamp` in seconds. These are the ADR-065 webhook headers, which a Nagios or Icinga command can
     compute with openssl. A timestamp outside `MONITORING.signatureToleranceMs` is refused as a replay. The API keeps
     the raw body (`rawBody: true`) so the signature covers the exact bytes.
   - `token` as one more path segment, but only when the integration's settings say `urlToken: true`. This is for
     Splunk's webhook alert action, which can be given a URL and nothing else.

   Comparisons are constant time. A credential is cached for `MONITORING.secretCacheMs`, so a burst of alerts reads
   OpenBao once. Values are never stored or logged.
3. **One normalised shape** (`packages/contracts/src/monitoring.ts`, `monitoringEventSchema`). Each alert carries a
   vendor, a fingerprint (stable at the source), a status (firing or resolved), a severity on the incident scale, a
   title, a description, its start and end, a source link, labels, and the **targets** it names the affected thing by
   (`ci_id`, `fqdn`, `instance`, `ip`, `hostname`). The parsers are pure and unit-tested:
   - **Prometheus Alertmanager**: webhook payload version 4, read as Alertmanager sends it (recorded from a real one).
     The alert's own fingerprint is used. Severity comes from the `severity` label. Targets come from `openmap_ci_id`,
     `fqdn`, `hostname`, `host`, `nodename`, `node`, `instance` (port stripped), `ip` and `address`. An `endsAt` of
     Go's zero time means still firing.
   - **Zabbix**: a webhook media type posting the parameters Zabbix's own webhook templates use: `event_source`,
     `event_value` (1 problem, 0 recovery), `event_id` (the fingerprint, shared by a problem and its recovery),
     `event_nseverity` (0–5), `event_name`, `event_date`/`event_time` (read as UTC), `event_tags`, `host_host`,
     `host_name`, `host_ip`, `host_dns`, `trigger_id`, `zabbix_url` and `alert_message`. Events that are not trigger
     events are accepted and ignored.
   - **Nagios / Icinga**: a notification command posting the standard macros as JSON: `notification_type`
     ($NOTIFICATIONTYPE$), `host_name`, `host_address`, `host_state`, `service_description`, `service_state`,
     `output`, `timestamp` ($TIMET$) and `url`. RECOVERY resolves. PROBLEM, ACKNOWLEDGEMENT, FLAPPINGSTART and CUSTOM
     fire. Downtime and flapping-stop notifications change nothing.
   - **Datadog**: a webhook whose payload template maps `$ALERT_ID`, `$ALERT_CYCLE_KEY` (the fingerprint: one cycle
     from trigger to recovery), `$AGGREG_KEY`, `$EVENT_TITLE`, `$EVENT_MSG`, `$ALERT_TRANSITION` (Recovered resolves),
     `$ALERT_TYPE`, `$ALERT_PRIORITY`, `$HOSTNAME`, `$TAGS` (`host:` and `openmap_ci_id:` tags), `$DATE` and `$LINK` to
     `alert_id`, `alert_cycle_key`, `aggreg_key`, `title`, `body`, `alert_transition`, `alert_type`, `priority`,
     `hostname`, `tags`, `date` and `link`.
   - **SolarWinds Orion**: the "send a GET or POST request to a web server" action on trigger and on reset, with
     `alert_name`, `alert_object_id` (the fingerprint), `alert_active_id`, `severity` (Critical, Serious, Warning,
     Notice, Informational), `action` (`trigger` or `reset`), `node_name`, `ip_address`, `dns`, `message`,
     `details_url` and `triggered_at`.
   - **Splunk**: the built-in webhook alert action (`result`, `sid`, `results_link`, `search_name`, `owner`, `app`).
     Targets come from the CIM fields of the first result (`dest`, `dest_host`, `dvc`, `host`, `dest_ip` and others).
     Splunk sends no resolve, so its alerts are **point in time**: they clear after `MONITORING.pointInTimeTtlMinutes`,
     or after the integration's `resolveAfterMinutes`, which any vendor may set.
4. **CI resolution reuses the reconciler's identity rules.** The order is:
   1. a CI id the alert names, when it is a current CI of the tenant;
   2. an operator's mapping of any of the alert's source keys;
   3. for each target in contract order, the CI whose ADR-045 ref tokens (identity values, name, and `fqdn`,
      `hostname` and address attributes) hold the value, with identity ranked above alias;
   4. the CIs whose identity tokens (migration 0031) hold `fqdn=`, `sysName=` or `hostname=` that value.

   A value that names more than one CI at its best rank names none. All of this takes four indexed probes per
   request. An alert that resolves to nothing is **kept** with `ciId` null, counted as unresolved and listed for mapping.
   `mapMonitoringSource(sourceKey, ciId)` stores the mapping. It resolves the tenant's unresolved alerts that name the
   key at once (a GIN index on `sourceKeys`) and later ones on arrival.
5. **Alerts are rows, kept per fingerprint** (`monitoring_alerts`, migration 0050). A repeat updates the row and
   counts it. A resolve closes the row and keeps the severity and title the firing message gave. A re-fire reopens it.
   While firing, `effect` is what the alert does to its CI. Critical and high set the CI down. Medium and low set it
   degraded. Informational has no effect. The integration's `maxEffect` (`down`, `degraded`, `none`) caps the effect.
   Each request also records an inbound `IntegrationDelivery`, marks the integration healthy, and writes, in the same
   transaction, an outbox event. `clearMonitoringAlert` resolves an alert by hand, for a sender that will never
   resolve it.
6. **No new event type.** The outbox event is the existing `openmap.integration.delivery.succeeded` with
   `data.kind = "monitoring"`. That is accurate: an inbound delivery succeeded. It is also the safe choice. The
   reconciler's dispatcher parses each claimed batch with the contract's envelope schema, so a dispatcher one release
   older than the API would throw on an unknown type at the head of the outbox and stall every tenant. A rolling
   upgrade must not be able to do that. The event contract stays 0.12.0.
7. **The BSM engine overlays alerts on observed health** (`apps/bsm-engine/src/service/monitoring.ts`). It keeps the
   worst firing effect per CI in memory and re-reads rows changed since the newest change it has seen, minus
   `MONITORING.syncOverlapMs` for writers' clock skew. The ingest's delivery event (or a mapping or a clear) wakes it,
   and it also runs every `MONITORING.engineSyncMs`, so a lost wake-up costs seconds. Before the first event is
   applied it loads every firing alert, so a restart cannot re-derive an alerted CI healthy. Each pass also clears
   point-in-time alerts whose time to live has run out.

   For each affected CI the graph health becomes the worse of `deriveHealth` over the stored CI and the alerts'
   effect. `applyCiEvents` and the refresh of unscored members apply the same overlay, so a new observation cannot
   hide a firing alert. Changed tenants are recomputed: propagation sets the service's health, and the existing
   incident flow opens, updates and resolves incidents. Incidents carry the alerts' delivery event ids in
   `correlatedEventIds`.
8. **Air-gapped deployments receive.** Ingest makes no outbound call and does not depend on
   `FEATURE_OUTBOUND_INTEGRATIONS` or the tenant's outbound switch. The monitoring tools sit inside the enclave with
   OpenMap. The integration's `enabled` flag is the switch.

## Consequences

- GraphQL 1.45.0 adds `MonitoringAlertStatus`, `MonitoringTarget`, `MonitoringAlert`, `MonitoringSourceMapping` and
  `MonitoringAlerts`, the query `monitoringAlerts(status, unresolvedOnly, first)`, and the operator mutations
  `mapMonitoringSource` and `clearMonitoringAlert`.
- Migration 0050 adds `monitoring_alerts` and `monitoring_source_mappings`.
- New metrics: `openmap_monitoring_events_total{vendor,outcome}` (API: resolved, unresolved, ignored, refused,
  invalid), `openmap_bsm_monitoring_syncs_total{outcome}` and `openmap_bsm_monitoring_health_changes_total`. New spans:
  `monitoring.ingest` (API, with the auth method and alert count) and `bsm.monitoring_sync`.
- The console has a Monitoring events screen at `/integrations/monitoring`, linked from Integrations. It shows each
  monitoring integration's address, the firing, unresolved and mapped counts, the alerts with their CI or "no CI
  found", mapping by search, and clearing.
- The ingest path takes vendor-native bodies, so it is not part of REST v1 (`REST_ROUTES`) or its OpenAPI document.
- Splunk's URL token is a secret in a URL. It is accepted only where an integration opts in, and Fastify's request
  logger is off.
- A Splunk integration of category `siem` sends security alerts. A separate `monitoring` integration of vendor
  `splunk` receives monitoring events.
