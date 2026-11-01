# REQ-UI-009 REQ-UI-010 REQ-UI-011 REQ-UI-014 REQ-UI-017 REQ-UI-018 — the six estate screens (2026-10-22)

Assets, IPAM, DCIM, Integrations, Analytics and Assistant were built against the live compose stack and verified on
the shipped images (`openmap/api:dev`, `openmap/console:dev`) with the scale-0.05 synthetic estate loaded.

## Unit tests (Vitest, en and ar)

| Test id | File | Covers |
| --- | --- | --- |
| T-100 | `apps/console/src/components/assets/AssetsView.test.tsx` | attention table, register, stage change, plan status, new plan form, analyst read-only |
| T-101 | `apps/console/src/components/integrations/IntegrationsView.test.tsx` | category filter, detail with mappings and deliveries, probe, admin form, analyst read-only |
| T-102 | `apps/console/src/components/ipam/IpamView.test.tsx` | tree and collapse, selected subnet addresses and next free IP, DNS and DHCP tabs |
| T-103 | `apps/console/src/components/dcim/DcimView.test.tsx` | room grouping and power, heat map selection, SVG elevation, devices and feeds |
| T-104 | `apps/console/src/components/assistant/AssistantView.test.tsx` | example prompt, answer with Cypher, rows and CIs, refusal with rejected Cypher |
| T-105 | `apps/console/src/components/analytics/AnalyticsView.test.tsx` | SDK handshake parameters and token fetcher, unavailable state |

Console suite: 25 files, 156 tests green. API integration suite (T-032, T-097): 15 tests green.

## End to end (Playwright, en and ar, `e2e/screens.spec.ts` T-106 and the walkthrough T-087)

```
24 passed, 1 skipped (perf in ar, by design)   1.3m
```

- IPAM: selects `10.0.0.0/24`, the address table and the next free address render; DNS tab lists zones.
- DCIM: selects a heat-map tile; the elevation (SVG `img`), mounted devices and power feeds render.
- Assets: a plan is created from the form and its planned assets appear in the register.
- Integrations: an integration is created, selected and probed; the outcome (healthy, last error, or the tenant's
  outbound policy refusing the call) is shown.
- Analytics: the Superset iframe mounts at `/embedded/<uuid>` with a tenant-scoped guest token.
- Assistant: the example question resolves to an answer with its Cypher, or to an explicit refusal with the reason.

## Lighthouse (desktop flow, `docs/evidence/perf/lighthouse.json`, re-measured 2026-11-01 on the rebuilt console)

| Screen | Performance | Accessibility | Best practices |
| --- | --- | --- | --- |
| discovery | 0.98 | 1 | 1 |
| assets | 1 | 1 | 1 |
| software | 1 | 1 | 1 |
| vulnerabilities | 1 | 1 | 1 |
| dependencies | 1 | 1 | 1 |
| integrations | 1 | 1 | 1 |
| ipam | 1 | 1 | 1 |
| dcim | 0.91 | 1 | 1 |
| analytics | 0.81 | 1 | 1 |
| assistant | 1 | 1 | 1 |

Analytics hosts Superset's own application inside the page; its blocking time is Superset's bundle executing in a
frame that, on the same-site dev stack, shares the console's renderer. The console shell itself paints in under a
second (FCP 0.2 s, LCP 0.4 s). `PERF_BUDGETS.lighthouseEmbeddedPerformanceMin` (0.7) documents the floor for such
screens; the standard 0.9 applies to everything else and the accessibility and best-practice floors apply to all.

## Data behind the screens

- IPAM and DCIM read the synthetic estate: 107 subnets (one /8 → seven /12 → ninety-nine /24, 70.5 % average
  utilisation), 101 racks in 4 rooms with 494 kW drawn from 202 PDUs. Two API defects surfaced and were fixed: the
  subnet CIDR lives in the CI identity (contract key), and rack placement uses `heightU`/`uPosition` on `located_in`.
- Assets and Integrations start empty on a fresh estate; the e2e creates a plan and an integration.
- Analytics: the API provisioned the dashboard in Superset (database, 5 datasets, 5 charts, layout, embedding, guest
  role) on first use; `analyticsEmbed` answers in about a second afterwards.
- Assistant: the dev stack runs `Qwen2.5-Coder-1.5B-Instruct` on llama.cpp (CPU). With the repair loop two of the
  four example questions are answered (hosts per OS, racks by power) and two are refused with the validator's or the
  engine's reason (an invented `$name` parameter; an unbound variable). Answer quality is the model's; the product
  behaviour — validated read-only Cypher shown with every answer, explicit refusals — is what the screen promises.
  `.env.example` names the 7B coder model for real deployments.

## Screenshots

`assets-en/ar.png`, `integrations-en/ar.png`, `ipam-en/ar.png`, `dcim-en/ar.png`, `analytics-en/ar.png`,
`assistant-en/ar.png` in this directory, captured by the walkthrough on the shipped image.

## Software and licences, Vulnerabilities, dependency map isolation (2026-11-01)

REQ-UI-015, REQ-UI-016, REQ-CMDB-030, REQ-CMDB-031, REQ-CMDB-035, REQ-SEC-008, REQ-DEP-005. Verified on the rebuilt
images (`openmap/api:dev`, `openmap/console:dev`) with the scale-0.05 estate: 31 software products, 3,098 installed
instances, 26 licences, 16 CVEs.

| Test id | File | Covers |
| --- | --- | --- |
| T-108 | `apps/api/src/api.integration.test.ts` | `software` with licence usage and the stored expiry, `vulnerabilitySummaries`, `vulnerability` blast radius to hosts and services |
| T-109 | `apps/console/src/components/software/SoftwareView.test.tsx` | catalogue rows, licence cells, posture groups, filter text and licensedOnly, utilisation helper |
| T-110 | `apps/console/src/components/vulnerabilities/VulnerabilitiesView.test.tsx` | ranked list, headline counts, CVSS/exposure/exploited filters, blast-radius panel with predicted states and truncation |
| T-060, T-061 | `graph-layout.test.ts`, `DependenciesView.test.tsx` | deterministic force layout, impact closure, isolation on click, layout toggle in the URL, double-click opens the CI |

End to end (`e2e/screens.spec.ts`, en and ar): `28 passed, 1 skipped (perf in ar, by design)` on the final images; the Analytics assertion
was made exact (`analytics.live`) after a strict-mode collision with the description text. Screenshots:
`software-{en,ar}.png`, `vulnerabilities-{en,ar}.png`, `dependencies-{en,ar}.png` beside this file.

A real defect surfaced on the shipped image: the estate stores licence expiry as a calendar date (`2027-01-01`), which
the contract's `DateTime` scalar rejected, so the Software screen showed an error while the direct API probe (which did
not select `expiresAt`) looked fine. The API now normalises date attributes to ISO instants (`isoAttribute`), and T-108
asserts the stored value.

## Discovery scopes (REQ-DISC-029, 2026-11-01)

Every subnet is a discovery scope: exclusions, credential set (OpenBao reference and type) and rate limit live as
subnet attributes, the planner honours them (T-010), `discoveryScopes` / `updateDiscoveryScope` expose and validate
them (GraphQL 0.7.0, ADR-015; T-112 in the API integration suite) and the Discovery screen's scopes card edits them in
place (T-067). The scope builder reads the CIDR from the subnet identity first: on the dev estate 106 of 107 subnets
were invisible to a sweep before. e2e (`screens.spec.ts`, en and ar): `30 passed, 1 skipped (perf in ar, by design)`; the scope test edits the
first scope's exclusions, credential set and rate limit and reads them back from the table (`discovery-{en,ar}.png`).

