# The asset register follows the CMDB (REQ-CMDB-039, REQ-CMDB-040, ADR-023)

Captured 2026-11-05 on the dev compose stack with the synthetic estate (scale 0.05).

## What changed on screen

- **Register per layer.** The Assets screen lists every owned item in the CMDB, not only a plan's BOM units: a layer
  strip with the count per layer and, in the warning tone, the rows missing a cover date; filters for text (tag,
  serial, make, model, CI name), data gap (any, warranty, support, end of life), stage and source (planned,
  discovered, manual); columns for the item, layer, CI, stage, warranty end, support end and end of support, where a
  missing date reads as a "Missing" tag and a past one in the down tone; a details panel per row with the cover and
  its source (vendor API, purchase record, entered by hand), the audited form (identity, purchase, custodian,
  warranty, vendor support, end of life, a note) and the audit trail.
- **Unknown devices.** Every CI in the unknown layer carries a diagnosis from what the scanners recorded: not seen
  for a month, power equipment answering SNMP (→ DCIM collector scope), a device answering SNMP (→ credential), an
  unknown application on a non-standard port (→ agent/SSH credential or label), no out-of-band management (→ manual
  entry), web interface only. The evidence (device kind, system description, vendor from OUI, open ports, SNMP,
  web interface, OS guess, last seen) and the suggested layer and type sit on the row; "Label this CI" opens preset
  with them and the labelled CI joins the register at once.
- **Manual entry.** "Record an unmanaged asset" creates the CI of the chosen owned type together with the register
  row, for an unmetered PDU or any device without management.

## The register on the dev estate after migration 0015

| Layer | Rows | With warranty | With support |
| --- | --- | --- | --- |
| Data centre (racks, PDUs, UPSs, cooling) | 320 | 0 | 0 |
| Network and security | 253 | 252 | 0 |
| Hardware (hosts, BMCs) | 4,016 | 2,000 | 0 |
| Storage | 9 | 0 | 0 |
| Virtualization | 1,635 | 0 | 0 |
| Cloud | 14 | 0 | 0 |
| Operating systems | 2,000 | 0 | 0 |
| Containers | 1 | 0 | 0 |
| Databases | 55 | 0 | 0 |
| Applications (software, instances, licences) | 3,178 | 0 | 26 |

9,481 discovery-sourced rows plus the 17 planned ones; 7,200 rows carry at least one gap, which is what the register
flags for entry. Nothing was invented: a row has a warranty only where the collector reported `warrantyEnd` and a
provider, support only where a licence reported its expiry and vendor.

## Tests

| Test | What it proves |
| --- | --- |
| T-127 `apps/reconciler/src/worker/assets.test.ts` | the row a CI deserves: owned types only, the organisation's tag first, vendor warranty, licence expiry as support, nothing invented |
| T-131 `apps/reconciler/src/worker/assets.integration.test.ts` | the array statements against Postgres: one row per owned CI, tag fallback, refresh without touching manual cover, idempotent |
| T-128 `apps/console/src/lib/unknown-remediation.test.ts` | the diagnosis rules |
| T-100 `apps/console/src/components/assets/AssetsView.test.tsx` | the screen in en and ar: KPIs, filters, details save, unknown diagnosis preset, manual entry |
| T-130 `apps/api/src/api.integration.test.ts` | createAsset makes the CI through the outbox, updateAsset audits per field and emits, gaps and summary follow, labelCi registers an unknown device |
| T-129 `apps/console/e2e/assets.spec.ts` | the whole flow on the real stack in both locales, screenshots below |

## Screenshots

- `docs/evidence/console/assets-register-en.png`, `assets-register-ar.png` — the register filtered to hardware.
- `docs/evidence/console/assets-details-en.png`, `assets-details-ar.png` — the details panel after saving an end-of-support date.
- `docs/evidence/console/assets-unknown-en.png`, `assets-unknown-ar.png` — unknown devices with their diagnosis.

## Measurements

Lighthouse sweep (`pnpm --filter @openmap/perf lighthouse`, generated 2026-11-05T05:32:12.226Z, kind cluster stopped, routes warmed;
floors perf 0.90 / a11y 0.95 / best-practices 0.95, analytics embedded floor 0.65 per ADR-026):

| Screen | Performance | Accessibility | Best practices |
| --- | --- | --- | --- |
| sign-in | 0.99 | 1.00 | 1.00 |
| dashboard | 0.98 | 1.00 | 1.00 |
| twin | 0.93 | 1.00 | 1.00 |
| setup | 0.99 | 1.00 | 1.00 |
| layers | 0.95 | 1.00 | 1.00 |
| discovery | 0.94 | 1.00 | 1.00 |
| dependencies | 1.00 | 1.00 | 1.00 |
| cmdb | 1.00 | 1.00 | 1.00 |
| assets | 0.96 | 1.00 | 1.00 |
| software | 1.00 | 1.00 | 1.00 |
| services | 1.00 | 1.00 | 1.00 |
| impact | 0.99 | 1.00 | 1.00 |
| integrations | 0.99 | 1.00 | 1.00 |
| ipam | 0.99 | 1.00 | 1.00 |
| dcim | 0.96 | 1.00 | 1.00 |
| vulnerabilities | 0.98 | 1.00 | 1.00 |
| analytics | 0.67 | 1.00 | 1.00 |
| assistant | 0.95 | 1.00 | 1.00 |
| settings | 0.93 | 1.00 | 1.00 |

Analytics is the embedded Superset frame: its 2.7 MB of script (64 requests) costs about 1.5 s of blocking time on
the throttled CPU whatever the console does; ADR-026 records the cost and the question of native charts.
