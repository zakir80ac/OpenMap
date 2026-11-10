# Monitoring event ingest (REQ-INT-012, ADR-073)

Captured 2026-11-10 on the dev compose stack: Postgres over TLS, Memgraph and OpenBao. The API and the BSM engine's
monitoring overlay and recompute ran in process in the integration test. The compose containers were not rebuilt or
restarted. Migration 0050 was applied to the shared database with `prisma migrate deploy`.

## What was tested for real and what was not

| Vendor                   | How it was exercised                                                                                                                                                                                                                                                                                      | Payload source                                                                                                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prometheus Alertmanager  | **A real Alertmanager** (`prom/alertmanager:v0.28.1`, digest `sha256:27c475db5fb1…`) ran in a throwaway `docker run --rm` container. Its `webhook_configs` posted to the in-process API at `http://host.docker.internal:<port>/ingest/monitoring/<id>` with `http_config.authorization` (Bearer). Alerts were fired and ended through its `/api/v2/alerts`. | Recorded from that container: `packages/testing/fixtures/monitoring/alertmanager-webhook-v4.json` (firing) and `alertmanager-webhook-v4-resolved.json` (resolved). The contracts unit test reads the firing one. |
| Zabbix                   | Not run: a Zabbix server needs its database and frontend. The mapping is unit-tested, and the endpoint is integration-tested with a payload in the media-type parameter shape.                                                                                                                              | Written from Zabbix's documented macros and its webhook templates' parameter names. **Not a recording.**                                                                                                  |
| Nagios / Icinga          | Not run. Unit tests, plus an integration test of the endpoint with an HMAC-signed payload and the same payload tampered.                                                                                                                                                                                   | Written from the standard notification macros. **Not a recording.**                                                                                                                                      |
| Datadog                  | Not run: SaaS only. Unit and integration tests.                                                                                                                                                                                                                                                            | Written from Datadog's documented webhook template variables. **Not a recording.**                                                                                                                       |
| SolarWinds Orion         | Not run: commercial Windows product. Unit tests, plus integration tests with basic credentials, trigger and reset.                                                                                                                                                                                         | Written from Orion's documented alert variables. **Not a recording.**                                                                                                                                    |
| Splunk                   | Not run: no Splunk instance is available. Unit tests, plus an integration test of the URL-token path.                                                                                                                                                                                                      | Written from Splunk's documented webhook alert action body. **Not a recording.**                                                                                                                         |

## Integration results (T-633, T-634)

`apps/api/src/monitoring/monitoring.integration.test.ts` ran against the compose stack, one file at a time
(`--no-file-parallelism`):

```
✓ T-633 every vendor > refuses unknown integrations, wrong credentials and payloads that are not the vendor's
✓ T-633 every vendor > accepts each vendor's payload, resolves the CIs it can and lists the one it cannot
✓ T-633 every vendor > lists the unresolved alert, and a mapping resolves it now and on its next message
✓ T-633 every vendor > turns firing alerts into CI and service health and an incident, and restores both when they end
✓ T-634 a real Prometheus Alertmanager > delivers a fired alert: db-01 and its service go down; ending it resolves both  1149ms
Tests  5 passed (5)   Duration 12.83s
```

It ran a second time in the airgap profile (`DEPLOY_PROFILE=airgap FEATURE_OUTBOUND_INTEGRATIONS=false`), and all 5
passed again (12.53 s). Ingest needs no outbound switch.

What the real Alertmanager run asserted:

1. Alertmanager posted the firing group. The API checked the bearer token against the OpenBao record and parsed the
   payload. It resolved `instance="db-01.lab.test:9100"` to the `db-01` host CI by identity, and stored the alert as
   firing with severity critical and effect down.
2. The engine overlay set `db-01` **down** in Memgraph. The recompute set the Payments business service **down** and
   opened an incident. Its root cause is `db-01`, and its `correlatedEventIds` hold the alert's delivery event.
3. The test ended the alert through Alertmanager's API. Alertmanager sent the `resolved` notification itself
   (`send_resolved: true`). The alert closed, `db-01` and Payments returned to **healthy**, and the incident was
   **resolved**.

The T-633 cases asserted:

- An unknown integration id gets 404. A missing or wrong bearer token gets 401. A URL token where the integration
  does not allow one gets 401. A body that is not the vendor's shape gets 400. In all of these, no row is written.
- Six vendors with six authentication styles all got 202. Each landed as follows:

  | Vendor        | Authentication       | Resolved to   | How                       |
  | ------------- | -------------------- | ------------- | ------------------------- |
  | Alertmanager  | bearer token         | `web-01`      | instance FQDN             |
  | Zabbix        | bearer token         | `db-01`       | `host_host` FQDN          |
  | Nagios        | HMAC signature       | `core-sw-01`  | name                      |
  | Datadog       | bearer token         | `db-01`       | `openmap_ci_id` tag       |
  | SolarWinds    | basic credentials    | nothing       | unresolved: `edge-rtr-02` |
  | Splunk        | URL token            | `web-01`      | name; carries `expiresAt` |

- Six inbound deliveries and six `openmap.integration.delivery.succeeded` events with `kind: monitoring` were
  recorded. The integration status went to healthy.
- `monitoringAlerts(unresolvedOnly: true)` over GraphQL listed the SolarWinds alert with its targets.
  `mapMonitoringSource("Edge-Rtr-02", <edge CI>)` normalised the key and resolved that alert "by mapping". The next
  SolarWinds alert for the same node resolved on arrival.
- With the alerts firing, CI health was: web-01 down, db-01 degraded (medium), core-sw-01 down, the edge router down.
  Payments went down, and `ci { health }` over GraphQL also said down. One incident opened, rooted at web-01, with the
  Alertmanager delivery event correlated.
- The test then resolved the alerts through each sender's own mechanism. Alertmanager sent resolved, Datadog
  Recovered and Zabbix `event_value 0`, and an operator ran `clearMonitoringAlert` on the Splunk alert. The resolved
  Alertmanager row kept its critical severity and title. web-01 and db-01 returned to healthy, core-sw-01 stayed down
  (Nagios still firing), Payments returned to healthy and the incident was resolved.

The compose reconciler logged no errors after the runs. The deployed dispatcher and engine accepted the delivery
events, because they are an existing type (ADR-073 §6).

## Unit results

| Test                                                                       | What it proves                                                                                                                                                                                                                                       | Result     |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `packages/contracts/src/monitoring.test.ts` (T-630)                        | host parts of instances and URLs; target order; severity words; effect cap; settings; each vendor's parser (firing, resolve, ignored events, refusals); the recorded Alertmanager payload                                                            | 11 passed  |
| `apps/api/src/monitoring/monitoring-auth.test.ts` (T-631)                  | bearer, basic (both halves), HMAC over the raw body with the replay window, URL token only when allowed, an empty credential refused; CI choice: CI id, then mapping, then ranked ref tokens, then identity tokens; ambiguity leaves the alert unresolved | 6 passed   |
| `apps/bsm-engine/src/service/monitoring.test.ts` (T-632)                   | worst firing effect per CI; the overlay never improves observed health; which events wake the sync; a sync pass that fires, worsens, eases and clears; a remapped alert leaves its old CI                                                            | 4 passed   |
| `apps/console/src/components/integrations/MonitoringEventsView.test.tsx` (T-635) | in en and ar: ingest address, counts, alerts with their CI and how it was matched or "no CI found", targets; mapping through search; clearing                                                                                                        | 4 passed   |

Whole-package runs after the change:

| Package     | Unit result                  |
| ----------- | ---------------------------- |
| contracts   | 121 passed                   |
| api         | 60 passed                    |
| bsm-engine  | 70 passed                    |
| console     | 388 passed (66 files)        |

`pnpm guard` passed, along with `tracker verify` (ok). Typecheck and lint passed for api, bsm-engine, console and
contracts. `pnpm contracts:check` reported "GraphQL schema 1.45.0 ok against HEAD". The i18n check reported en and ar
in sync.

## End to end (T-636)

`apps/console/e2e/monitoring-events.spec.ts` is **written, not run** here, because the compose console image runs the
old code. It works per locale project. Through the API, it saves an `api_token` credential and an inbound Alertmanager
integration. It then posts an Alertmanager payload naming an unknown host and opens Monitoring events from
Integrations. On that screen it:

1. finds the address;
2. filters to "No CI found";
3. maps the alert to a host found by search;
4. sees the alert "by mapping";
5. clears it.

The screenshots `monitoring-events-{en,ar}.png` are its RTL evidence once it runs.

## Observability

- **API:** metric `openmap_monitoring_events_total{vendor,outcome}` (resolved, unresolved, ignored, refused, invalid).
  Span `monitoring.ingest` with `openmap.vendor`, `openmap.auth_method` and `openmap.alerts`.
- **Engine:** metrics `openmap_bsm_monitoring_syncs_total{outcome}` and `openmap_bsm_monitoring_health_changes_total`.
  Span `bsm.monitoring_sync`.
