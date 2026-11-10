# Field encryption through OpenBao Transit (REQ-SEC-011 step 4, ADR-067)

Captured 2026-11-10 on the dev compose stack, which runs encrypted PostgreSQL (step 3) and production OpenBao (step 1).

## What is encrypted

pg_tde protects the files. Some personal data must also stay unreadable to anyone who can query the database, and in
`pg_dump` output. Those values are stored as OpenBao Transit ciphertext (`vault:v<n>:…`, key `openmap-fields`,
aes256-gcm96), and only the API decrypts them:

| Data | Where | Encrypted on write | Decrypted on read |
| --- | --- | --- | --- |
| Vendor contact name, email, phone | `vendor_contacts` | `upsertVendorContact` | `vendor { contacts }`, a support contract's `primaryContact` |
| Asset custodian | `asset_records.custodian` | `updateAsset`, `createAsset` | every asset read, one batch per page |
| Custodian changes in the audit trail | `asset_audits` (`field = 'custodian'`) | with the asset change | `audits` |
| Custom fields created as `sensitive` (text only) | `cis."customFields"` | `setCiCustomFields` | `Ci.customFields`, batched per request by the `plaintext` loader |

## How it behaves

- **The key stays in OpenBao.** The services' policy allows `transit/encrypt/openmap-fields` and
  `transit/decrypt/openmap-fields`, nothing else on Transit.
- **Without OpenBao, a write fails** (503); it never falls back to plaintext. A value stored before encryption still
  reads back, because a value without the prefix is returned as it is.
- **The same plaintext encrypts differently every time** (random nonce). The database cannot compare these values,
  so:
  - contacts are sorted after decryption;
  - the primary contact is chosen by escalation level and then by entry time;
  - a CI filter on a sensitive field is refused;
  - the console leaves sensitive fields out of its filter list.
- **Changes are compared in plaintext.** Setting a custodian to its current value is no change and no audit entry.
- **Plaintext that looks like ciphertext is refused.** A text value may not start with `vault:v`, so a stored value is
  always told apart from one that was encrypted.
- **The flag is fixed.** A field is sensitive or not from its creation, so no field ever holds both kinds of value.
- **Change events carry the ciphertext.** ClickHouse history and the event stream never hold the plaintext.
- **Backfill:** `reconciler encrypt-fields [--tenant]` encrypts what was written before. Running it again does
  nothing.
- **Observability:** span `field_cipher.encrypt|decrypt` and metric
  `openmap_field_cipher_values_total{op,outcome}` in the API; span `reconciler.encrypt_fields`.

## Contracts

- CI 0.12.0: custom-field contract 0.2.0, `sensitive`, `sensitiveKeys`, the ciphertext-prefix rule.
- GraphQL 1.40.0: `CustomFieldDefinition.sensitive`, `CustomFieldDefinitionInput.sensitive`.
- Migration 0045.

## Tests

| Test | What it proves | Result |
| --- | --- | --- |
| `packages/vault/src/cipher.test.ts` (T-575) | one batch to the field key, base64 plaintext, nulls and ciphertext untouched, legacy plaintext returned without a call, batches split at `VAULT.transitBatch`, a refused request is an error | 4 passed |
| `packages/vault/src/vault.integration.test.ts` (T-575) | against production OpenBao with an AppRole on the services policy: batch round trip including Arabic, a fresh ciphertext per encryption | 3 passed |
| `packages/contracts/src/custom-field.test.ts` (T-576) | `sensitive` only on text fields, default false, ciphertext-like text refused, `sensitiveKeys` | 4 passed |
| `apps/console/src/components/cmdb/CustomFieldsEditor.test.tsx` (T-577) | the form sends `sensitive` for a text field only | console 384 passed |
| `apps/api/src/api.integration.test.ts` (T-578) | all four kinds stored as ciphertext and returned decrypted; contacts sorted after decryption; custodian audit decrypted; an unchanged custodian is no change; flag fixed; filter refused; forged ciphertext refused; the change event holds no plaintext | 1 passed |
| `apps/reconciler/src/encrypt-fields.integration.test.ts` (T-579) | the backfill encrypts plaintext contacts, a custodian and its audit (Arabic included), leaves nulls alone, and a second run reports zero | 1 passed |
| Dev data | `encrypt-fields` on the stack: 6 vendor contacts encrypted in 394 ms; 0 left in plaintext | done |
| Playwright (full suite) | every screen, en and ar, against encrypted PostgreSQL with field encryption. The run first found the collation change (step 3 evidence), the assistant example button now matching past conversations (scoped to its labelled group), and a frame-rate measure capped by the display (vsync now off for the perf spec: 540 fps against 60) | 103 passed, 1 skipped |
