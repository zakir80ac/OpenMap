# Custom fields on every CI (REQ-CMDB-015)

Captured 2026-11-05 on the dev compose stack with the synthetic estate.

## What changed

1. **Contract** (`packages/contracts/src/custom-field.ts`, custom-field 0.1.0): a definition has a camelCase key
   (fixed once created), labels in English and Arabic, a description, a type (text, number, date, yes/no, choice),
   the options of a choice, the CI types it applies to (none means every type) and whether it is required. One
   validator reads values for the API and the console alike: text trimmed and capped, numbers finite, dates that
   round-trip as YYYY-MM-DD (30 February is refused, not rolled over), yes/no, a choice from its options, null to
   clear; a key that does not apply to the CI's type is refused, and a required field cannot be cleared by hand.
2. **Storage** (migration 0020): `custom_field_definitions` per tenant (unique key) and `cis.customFields` (JSONB,
   default `{}`, GIN index). The reconciler's statements name their columns and never write this one, so discovery
   never overwrites a value a person entered; an integration test proves it against the real pipeline.
3. **API** (GraphQL 1.9.0, additive): `customFieldDefinitions(type)` with the number of CIs carrying each,
   `upsertCustomFieldDefinition` and `deleteCustomFieldDefinition` (administrators; deleting clears the values from
   every CI in one transaction), `setCiCustomFields` (operators; emits `openmap.ci.updated` with the CI),
   `Ci.customFields`, and `CiFilter.customFields` for search. All writes are audited by the global interceptor.
4. **Console**: Settings has a Custom fields card (list with labels in the console's locale, type, types it applies
   to, usage; administrators add, edit and remove with a confirmation that says how many values go); the CI detail has
   a Custom fields card with the fields of its type and a typed form for operators; the CMDB list filters by a custom
   field and its value.

Values live on the CI. The asset register row of an owned CI belongs to that CI, so its custom fields are the CI's.

## Tests

| Id | What | Result |
| --- | --- | --- |
| T-164 | `packages/contracts/src/custom-field.test.ts`: definition input, value reading per type (the 30 February case), change application against the CI's type, required, stale keys dropped | 3 of 3 |
| T-165 | `apps/api/src/api.integration.test.ts`: definitions by an administrator (operator refused, duplicate key, key change refused), per-type listing, values normalised and validated, viewer refused, filter by value, usage counts, delete clears values | 1 of 1 (suite 24 of 24) |
| T-166 | `apps/reconciler/src/worker/custom-fields.integration.test.ts`: a later sweep changes attributes and tags while the custom fields and a hand-set lifecycle stay | 1 of 1 |
| T-167 | `apps/console/src/components/cmdb/CustomFieldsEditor.test.tsx` (en, ar): only changes are sent, bad values block the save, a type without fields points to Settings, Settings add and remove for administrators, read-only for others | 9 of 9 |
| T-168 | Playwright `apps/console/e2e/custom-fields.spec.ts` (en, ar): an administrator defines a choice field for hosts, sets it on a host, finds the host through the CMDB filter, removes the field | 2 of 2 |

Also green: `pnpm guard`, `pnpm i18n:check` (45 new keys per locale), `pnpm contracts:check` (1.9.0 additive, one
dangerous change: the optional `CiFilter.customFields`), console lint, console, contracts and reconciler unit suites.

## Screenshots

- `console/custom-fields-ci-en.png`, `console/custom-fields-ci-ar.png`: a host's Custom fields card with the value the
  e2e set.
- `console/custom-fields-settings-en.png`, `console/custom-fields-settings-ar.png`: the Settings page after the
  e2e, scrolled to the audit log, which records the definition, the value and the removal.
