# Encrypted backup sets (REQ-SEC-011 step 5, ADR-067)

Captured 2026-11-10 on the dev compose stack.

## Design

- **The data key.** `deploy/backup/openmap-backup.sh create` asks OpenBao Transit for a fresh 256-bit data key for each
  set (`transit/datakey/plaintext/openmap-backup`). Only the wrapped key goes into the manifest (`encryption.key`,
  `vault:v1:…`).
- **The files.** `postgres.dump.enc` (the `pg_dump` custom archive) and `clickhouse.tar.enc` (a tar of the ClickHouse
  native backup) are encrypted, then authenticated:
  - AES-256-CTR with an encryption key, and HMAC-SHA256 over the ciphertext with a MAC key;
  - both keys are derived from the data key (HMAC-SHA256 of `enc` and `mac`);
  - each file has its own random IV;
  - IV and MAC are in the manifest.
- **No plaintext stays behind.** The plaintext archive and directory are removed once encrypted.
- **`verify`** checks the sha256 of each encrypted file, unwraps the key through Transit, checks both MACs, and then
  lists the PostgreSQL archive through a decrypting pipe.
- **`restore`** decrypts beside the set (pg_restore seeks in a custom archive) and removes the plaintext on exit.
- **The OpenBao snapshot is not encrypted with the data key.** OpenBao already encrypts its storage with the seal key,
  and the snapshot is what brings `openmap-backup` back after a disaster.
- **Policy.** The backup AppRole may take a data key from `openmap-backup` and decrypt with it, besides the snapshot.
  The key never leaves OpenBao.
- **`BACKUP_ENCRYPTION`.** `required` (the default) refuses to write a set without OpenBao. `off` writes plaintext
  sets. Older plaintext sets still verify and restore.
- **Visibility.** The API's `BackupSet.encrypted` (GraphQL 1.40.0) is shown as a tag on Settings → Backups.

## Results

| Check | Result |
| --- | --- |
| Encrypted set of the dev stack (9.4 GB PostgreSQL logically, 1.4 GB ClickHouse, 750,172 CIs) | **68 s** to create (56 s for a plaintext set on 2026-11-10); `verify` 8 s |
| Files in the set | `postgres.dump.enc` (699 MB), `clickhouse.tar.enc` (1.40 GB), `openbao.snap`, `manifest.json`; no plaintext archive or directory |
| `pg_restore --list` on `postgres.dump.enc` without the key | fails (not an archive) |
| Without OpenBao credentials, `BACKUP_ENCRYPTION=required` | refused before anything is written; no directory left |

## Tests

| Test | What it proves | Result |
| --- | --- | --- |
| `apps/reconciler/src/backup.integration.test.ts` (T-568, T-580) | the real backup container on scratch databases: the set is encrypted (manifest `encryption`, `.enc` files only, the raw archive unreadable), is verified and restored, and the graph and search are rebuilt; a changed byte with its checksum rewritten to match still fails, on the MAC | 2 passed |
| `packages/contracts/src/backup.test.ts` (T-580) | the manifest reads an encrypted set (wrapped key, archive, IV and MAC per file); a plaintext set has none; a key that is not Transit ciphertext is refused | 3 passed |
| `apps/api/src/backups/backups.integration.test.ts` | `BackupSet.encrypted` from the manifest | run with the API suite |
| `apps/console/src/components/settings/BackupsCard.test.tsx` | the Encrypted tag on an encrypted set, none on a plaintext one | console suite |
