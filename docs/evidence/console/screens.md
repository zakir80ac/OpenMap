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

## Lighthouse (desktop flow, `docs/evidence/perf/lighthouse.json`)

| Screen | Performance | Accessibility | Best practices |
| --- | --- | --- | --- |
| assets | 0.91 | 1 | 1 |
| integrations | 1 | 1 | 1 |
| ipam | 1 | 1 | 1 |
| dcim | 0.92 | 1 | 1 |
| analytics | 0.82 | 1 | 1 |
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
