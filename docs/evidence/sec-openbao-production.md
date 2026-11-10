# Production OpenBao (REQ-SEC-011 step 1, ADR-067)

Captured 2026-11-10 on the dev compose stack, after replacing the dev-mode OpenBao (in memory, root token).

## What runs

| Item           | Before                         | Now                                                                                          |
| -------------- | ------------------------------ | -------------------------------------------------------------------------------------------- |
| Image          | openbao/openbao:2.3, `-dev`    | openbao/openbao:2.7.2, `server -config=openbao.hcl`                                          |
| Storage        | memory (lost on restart)       | Raft on the `openbao-data` volume                                                            |
| Unseal         | none (dev mode)                | auto-unseal, static key seal (32-byte key in `openbao-unseal`); PKCS#11 or KMIP via config  |
| Init           | none                           | `openbao-init`: recovery keys 5/3 and root token in `openbao-init` (to move offline)         |
| Service access | root token `openmap-dev-root`  | AppRole `openmap-services` (KV v2 under the mount, Transit `openmap-fields`), 1 h tokens      |
| Backup access  | none                           | AppRole `openmap-backup`: Raft snapshot only, taken into every backup set                    |
| Monitoring     | none                           | Prometheus job `openbao` on `/v1/sys/metrics`                                                |
| Helm           | dev-mode Deployment            | StatefulSet with a PVC, seal key and AppRole ids generated once (kept), post-install init job |

`bao status` after a container restart: `Seal Type static`, `Initialized true`, `Sealed false`, `Storage Type raft`,
`Version 2.7.2`.

From inside the API container, with the AppRole files the services mount: login `approle`; KV write 200, read 200;
`sys/mounts` 403; Transit encrypt 200 (`vault:v1:` ciphertext).

## Tests

| Test                                                         | What it proves                                                                                                                                                                                                                                      | Result                      |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `packages/vault/src/index.test.ts` (T-572)                   | AppRole login from the id files, the token reused until three quarters of its lease and renewed after, one login shared by concurrent callers, a refused token forgotten, a given token without AppRole, a clear error with nothing configured        | 4 passed                    |
| `packages/vault/src/vault.integration.test.ts` (T-573)       | against the stack: server mode with Raft and the static seal, unsealed; a throwaway AppRole on the services policy logs in, writes and reads KV, is refused `sys/mounts`, encrypts and decrypts with Transit; a revoked token is replaced by a new login | 2 passed                    |
| `apps/reconciler/src/backup.integration.test.ts` (T-568)     | the backup set now carries an OpenBao Raft snapshot taken with the backup AppRole                                                                                                                                                                    | 2 passed                    |
| `apps/bsm-engine/src/integrations/notify.integration.test.ts` | credentials written to and read from the production OpenBao                                                                                                                                                                                         | 2 passed                    |
| Unit suites                                                  | API 51, scheduler 26, BSM engine 66 with the AppRole-based clients                                                                                                                                                                                   | passed                      |
| Playwright (full suite)                                      | every screen, en and ar, against the stack on the production OpenBao. The first full run found the twin's Memgraph timeout (fixed in 3feaa6b, impact breadth first), the SaaS part-number name and a perf locator; the three were re-run after their fixes | 107 passed, 1 skipped; then twin 3, saas 3, perf and walkthrough 4 passed |
