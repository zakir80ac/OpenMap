# CMDB import and export, seeding from another CMDB (REQ-CMDB-033, REQ-CMDB-036)

Captured 2026-11-06 on the dev compose stack with the synthetic estate. Decision: ADR-032.

## What changed

1. **Contract** (`packages/contracts/src/import.ts`, GraphQL 1.10.0): a CSV reader (quotes, doubled quotes, line
   breaks in a field, CR LF, byte-order mark), the column targets (`name`, `type`, `tags`, `identity.<key>`,
   `attribute.<key>`, `external.<key>`, `ignore`), `suggestMapping` from the headers, and the ServiceNow preset: a
   `cmdb_ci` export (`sys_id`, `sys_class_name`) is recognised, classes map to CI types and `sys_id` becomes the
   `servicenow` external id. Each row becomes an observation or is refused with its reason.
2. **API**: `previewImport` reads a CSV or Excel file (up to 10 MB) and returns the proposed mapping, the first rows
   and the refused ones; `runImport` publishes the accepted rows on the results queue as the `import` collector, so
   the reconciler merges them like any sweep. Imports run at confidence 0.6, under discovery's 0.9, so an imported
   value fills a gap and never overwrites what discovery observed. `importJobs` lists every run with what it created
   (migration 0021). `GET /export/cis?format=csv|xlsx|json` streams the filtered CMDB a page at a time; the CSV header
   names the import targets, so an export re-imports as is.
3. **Console**: the CMDB screen exports the filtered list as CSV, Excel or JSON and links to the import screen. That
   screen previews the file, lets an operator change each column's target and the default type, shows the refused
   rows, imports, and lists past imports.

Fixed during this verification: the API's CORS settings now expose `content-disposition`, so the browser keeps the
dated file name the API gives an export (`openmap-cis-<timestamp>.csv`) instead of the console's fallback name.

## Tests

| Id | What | Result |
| --- | --- | --- |
| T-169 | `packages/contracts/src/import.test.ts`: RFC 4180 CSV read and written back, a ServiceNow export recognised and its classes mapped, a generic sheet mapped by its headers with the default type | 3 of 3 |
| T-170 | `apps/api/src/imports/imports.integration.test.ts`: a discovered host, then a spreadsheet naming it with another vendor and a new attribute, a new host and a row with no name; the discovered vendor stays, the new attribute fills in, the new host is created as managed at import confidence, the job counts it; the export returns the host in CSV, XLSX and JSON | 2 of 2 |
| T-171 | `apps/console/src/components/cmdb/ImportView.test.tsx` (en, ar): column targets and file format; a file previewed, a column remapped, checked again and imported; a non-operator sees the job list only | 5 of 5 |
| T-172 | Playwright `apps/console/e2e/import-export.spec.ts` (en, ar): CSV export of a filtered CMDB with the dated file name and the import header, then a ServiceNow export previewed, one row refused for an unknown class, imported, and listed as a job | 2 of 2 |

Also green: `pnpm guard`, `pnpm i18n:check`, `pnpm contracts:check`, console lint, the API integration suite
(25 of 25) and the CMDB e2e specs (13 of 13 in en and ar).

## Screenshots

- `console/import-preview-en.png`, `console/import-preview-ar.png`: a ServiceNow export recognised, the proposed
  mapping with each column's first value, one refused row and its reason.
- `console/import-jobs-en.png`, `console/import-jobs-ar.png`: the import finished and listed with what it created.
