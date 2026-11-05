# Editing CIs by hand: lifecycle, tags, filters, and audited asset stages (REQ-CMDB-013, REQ-CMDB-016, REQ-CMDB-018)

Captured 2026-11-05 on the dev compose stack with the synthetic estate.

## What changed

1. **API** (GraphQL 1.8.0, additive): `setCiLifecycle(ciId, lifecycle)` and `setCiTags(ciId, tags)` for operators,
   `ciTags(limit)` for everyone. Tags are trimmed, de-duplicated, sorted and held to `CI_EDIT.tagPattern` (letters and
   digits in any script plus `. _ : / -`), `CI_EDIT.maxTagLength` and `CI_EDIT.maxTags`. Both mutations emit
   `openmap.ci.updated` carrying the CI, so Memgraph and the search index take the change, and the global interceptor
   audits them. The reconciler keeps a hand-set lifecycle on later sweeps (an update spreads the stored CI); a tag a
   collector observes again is merged back on its next sweep. `CiFilter` already took types, lifecycle and tags.
2. **Console**: the CMDB list gains type (narrowed to the selected layer), lifecycle and tag filters (the tag picker
   shows each tag with its count); the CI detail header shows the lifecycle as a select for operators, and the Tags
   card becomes an editor (remove with the button beside a tag, add from a field suggested from the tenant's tags,
   refused before it is sent when malformed). Viewers see both read-only.
3. **Asset lifecycle (REQ-CMDB-018)** was already implemented (`ASSET_STAGES`, `setAssetStage` with an audit row and
   an outbox event, the stage select on the register); what was missing was an end-to-end test that changes a stage
   and finds it in the audit trail. Any stage may move to any other: Device42's lifecycle has no transition rules
   either, and the audit trail records every move.

## Tests

| Id | What | Result |
| --- | --- | --- |
| T-161 | `apps/api/src/api.integration.test.ts`: lifecycle to managed, tags normalised (an Arabic tag included), a malformed tag refused, `ciTags` counts, the CMDB filter by tag and lifecycle, the event carries the CI, a viewer refused | 1 of 1 (suite 23 of 23) |
| T-162 | `apps/console/src/components/cmdb/CiEditors.test.tsx` (en, ar): lifecycle select, tag remove and add, malformed tag blocked, suggestions, read-only for a viewer; `CmdbView.test.tsx`: type, lifecycle and tag filters sent to `cis` | 4 of 4; CMDB suite 18 of 18 |
| T-163 | Playwright `apps/console/e2e/cmdb-edit.spec.ts` (en, ar): a host moved to managed and tagged, found again by the lifecycle and tag filters, then restored; an asset's stage changed and found in its audit trail with the new value, then restored | 4 of 4 (with assets.spec 7 of 7) |

Also green: `pnpm guard`, `pnpm i18n:check` (11 new keys per locale), `pnpm contracts:check` (1.8.0 additive), console
lint, console unit suite.

## Screenshots

- `console/cmdb-edit-en.png`, `console/cmdb-edit-ar.png`: a host's Tags card with the tag the e2e added.
- `console/assets-stage-audit-en.png`, `console/assets-stage-audit-ar.png`: the asset details panel with the stage
  change in its audit trail.
