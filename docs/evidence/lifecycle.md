# Operating system inventory and end of sale / support (REQ-CMDB-023, REQ-CMDB-025)

Captured 2026-11-07 on the dev compose stack. Decision: ADR-039 (Syed's option (c), 2026-11-06).

## What changed

1. **Catalogue** (migration 0026 `lifecycle_entries`, contract `lifecycle.ts`, CI 0.5.0): releases with release date,
   end of active, security and extended support, latest version and LTS; one row per source, product and cycle.
2. **Bundled snapshot** `packages/db/lifecycle/endoflife-date.json`: fetched on 2026-11-07 from endoflife.date by
   `node packages/db/dist/cli.js lifecycle-snapshot` (34 products, the publisher's rows unchanged); loaded by the
   `migrate` job (`all`) or `lifecycle`: 673 releases on the dev database.
3. **Optional sync**: `syncLifecycleCatalogue` (admin) only where the deployment and tenant allow outbound calls;
   audited as `lifecycle.synced`.
4. **Matching**: OS CIs by os-release `id`/`versionId` (SSH), `caption` (WMI) or `name`/`version`; network OS by
   `osName`/`osVersion`; hypervisors by `product`. Uncovered products (Nutanix AHV, NX-OS, Arista EOS) show as not in
   the catalogue.
5. **API** (GraphQL 1.17.0): `lifecycleReleases` (worst first, counts per state, patch currency for OS, the CIs on a
   release), `lifecycleHardware` (asset register end of sale and support by model), `lifecycleCatalogue`.
6. **Console**: Lifecycle screen under Insight with operating systems, hypervisors and network OS, hardware, and the
   catalogue card.

On the dev estate: Windows Server 2022, RHEL 9 and Ubuntu 24.04 are supported; Nutanix AOS 6.10 ended on 2026-10-31;
F5 BIG-IP 17.1 and PAN-OS 11.1 end within 180 days; Nutanix AHV, NX-OS and Arista EOS are not in the catalogue.

## Tests

| Id | What | Result |
| --- | --- | --- |
| T-208 | `packages/contracts/src/lifecycle.test.ts`: endoflife.date rows with dates or booleans, states, OS releases (Ubuntu, RHEL, Debian, SLES, Amazon Linux, Windows Server captions and names, ESXi; AHV uncovered), network OS and hypervisor releases | 4 of 4 (suite 42 of 42) |
| T-209 | `apps/api/src/api.integration.test.ts`: Windows Server 2012 R2 hosts matched and ended with one behind on patches, AHV not in the catalogue, IOS XE 17.12 matched, state filter, a release's CIs, hardware by model with the earliest date governing, catalogue sources, the sync refused for an operator and refused for an admin while outbound calls are off | 1 of 1 |
| T-210 | `apps/console/src/components/lifecycle/LifecycleView.test.tsx` (en, ar): OS rows worst first with ended-ago and patch currency, a release opened to its CIs, not-in-catalogue rows, the platform and hardware tabs, the state filter reaching the query, the sync offered only to an admin where allowed | 5 of 5 |
| T-211 | Playwright `apps/console/e2e/lifecycle.spec.ts` (en, ar): the dev estate's OS releases supported and AHV not in the catalogue, a release's CIs, Nutanix AOS 6.10 ended leading the platform tab, IOS XE 17.12 listed, hardware by model, the catalogue source | 2 of 2 |
| T-212 | `packages/db/src/lifecycle.test.ts`: the bundled snapshot holds every catalogue product with readable releases; the fetcher asks for each product, keeps rows as published and reports failures | 2 of 2 |

## Screenshots

- `console/lifecycle-os-en.png`, `console/lifecycle-os-ar.png`
- `console/lifecycle-platforms-en.png`, `console/lifecycle-platforms-ar.png`
- `console/lifecycle-hardware-en.png`, `console/lifecycle-hardware-ar.png`
