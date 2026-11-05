# ADR-032 — CMDB import and export: files through the reconciler, never around it

Status: Accepted and implemented (REQ-CMDB-033, REQ-CMDB-036, 2026-11-05) · Date: 2026-11-05 · Tracker: REQ-CMDB-033, REQ-CMDB-036

## Context

Device42 imports spreadsheets and other CMDBs' exports to seed an estate, and exports any CI list for reporting and
for other tools (CAPABILITY-MAP §4, "bulk import and export"; "seed from another CMDB"). OpenMap already has one way
CIs enter the store: an observation on the results queue, merged by the reconciler under the confidence rules of
ADR-005. A second write path for imports would bypass identity matching, the outbox fan-out to Memgraph, ClickHouse
and Meilisearch, and the history.

## Decision

1. **An import is a collector run.** `previewImport` and `runImport` (GraphQL 1.10.0) take a CSV or XLSX file as
   base64 (up to `IMPORTS.maxFileBytes`), read it with the contract's `parseCsv` or ExcelJS, and map columns to
   targets (`name`, `type`, `tags`, `identity.<key>`, `attribute.<key>`, `external.<key>`, `ignore`) with
   `importMappingSchema`. `runImport` publishes the accepted rows as observations from the `import` collector, in
   chunks of `IMPORTS.resultChunk` sharing one run id (each chunk its own queue job id, so BullMQ does not drop them
   as duplicates). The reconciler merges them like any sweep.
2. **Imported values never overwrite discovery.** The reconciler gives the import source `importSeedConfidence`
   (0.6), below discovery's 0.9: an imported value fills an attribute discovery has not observed and loses to one it
   has. A CI the import creates starts in `IMPORTS.createdLifecycle` (managed).
3. **Other CMDBs through their exports.** `suggestMapping` proposes a mapping from the headers; a ServiceNow
   `cmdb_ci` export (`sys_id` and `sys_class_name` present) is recognised and mapped through `SERVICENOW_PRESET`
   (class to CI type, `sys_id` to `external.servicenow`). An unknown class is refused per row with the reason.
4. **Every import is a job.** `ImportJob` (migration 0021) keeps the file name, format, mapping, counts per type,
   refused rows (up to `IMPORTS.maxRejectedShown`), the run id and who submitted it; `importJobs` reports how many
   CIs each run created by `sourceRunId`.
5. **Export streams.** `GET /export/cis?format=csv|xlsx|json` with the CMDB filter (types, layers, lifecycle, tags,
   text) pages the CI repository `IMPORTS.exportPageSize` at a time into the response: CSV with a byte-order mark
   so Excel reads UTF-8, XLSX through ExcelJS's streaming writer, JSON as an array. The CSV header names the import
   targets, so an export re-imports with every row accepted.
6. **The console.** The CMDB screen exports the filtered list in each format and links to the import screen, which
   previews the file with the proposed mapping, lets an operator change each column's target and the default type,
   shows the refused rows, imports, and lists the jobs with what each created.

## Consequences

- Imports inherit identity matching, history, the outbox and every downstream store with no new write path.
- A live pull from a ServiceNow instance needs an instance to test against; the export-file preset covers seeding
  until one is available.
- Fastify's body limit is `IMPORTS.maxBodyBytes` to carry a base64 file of the maximum size.
