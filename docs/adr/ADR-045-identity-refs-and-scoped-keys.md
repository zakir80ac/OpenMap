# ADR-045 — Reconciliation resolves `*Ref` values and scopes issuer-bound global keys

Status: Accepted (REQ-CORE-013, REQ-QA-005, 2026-11-07) · Date: 2026-11-07 · Tracker: REQ-CORE-013, REQ-QA-005

## Context

Simulated mode (ADR-042, ADR-044) left three identity gaps in reconciliation (`apps/reconciler/src/core/identity.ts`):

1. **Observers name a parent CI differently.** A `*Ref` identity value names another CI. A load balancer names a pool
   member by its IP or FQDN. The host's own collector keys the same listener by the host's serial or UUID. The tuples
   differ, so one listener became two CIs. Simulated mode counted 284 such drifts, all `listening_service` pool
   members.
2. **Some global keys are unique only within their issuer.** `tenantId` was global on its own. On the dev replay of
   2026-11-07, the ServiceNow instance `horizonbank` and the Workday tenant `horizonbank` became one CI. The same flaw
   applied to:
   - `accountId` and `resourceId` (GCP and Alibaba ids are numeric);
   - `clusterId` (a database cluster named `main` on two engines);
   - `moRef`;
   - `contractNumber` (two vendors can issue the same number).
3. **A global key can name a type's parent.** The estate check this ADR adds found that every `k8s_namespace` carries
   its cluster's `clusterUid`, a global key. All namespaces of a cluster therefore merged into one.

## Decision

1. **Contract tables (CI contract 0.7.0, `packages/contracts/src/ci.ts`):**
   - `GLOBAL_IDENTITY_SCOPES` lists each issuer-bound key and its scope:
     - `tenantId` by `vendor`;
     - `accountId` and `resourceId` by `provider`;
     - `clusterId` by `platform` or `engine`;
     - `moRef` by `platform`;
     - `contractNumber` by `vendorRef`.
     A scoped key matches on its own only when the scope keys its type declares are present and equal too. Otherwise it
     matches through the full tuple only.
   - `PARENT_IDENTITY_KEYS` lists global keys that name the parent in a type (`k8s_namespace.clusterUid`). They match
     only as part of the tuple.
   - `IDENTITY_REF_TARGETS` lists, for every `*Ref` key, the CI types it can name (`hostRef` names `host` or `vm`,
     `deviceRef` names a network device, load balancer, host or VM…). `vrfRef` and `directoryRef` name nothing that
     is a CI on its own; they are compared as written.
   - `IDENTITY_REF_ALIAS_ATTRIBUTES` lists the attributes that also name a CI: `fqdn`, `hostname`, `primaryIp`,
     `ipAddress`, `managementIp`.
   - `IDENTITY_REF_DERIVED` lists the spellings collectors derive from identity values: `serial:<serial>` and
     `name@version`.
2. **Pure rules (`packages/contracts/src/identity.ts`)** are shared by the reconciler, the estate check (T-450) and,
   through `schemas/ci-identity.json`, the Go simulator.
   - **Ref tokens.** A CI's ref tokens are every normalised spelling a ref may name it by. Identity values (global keys,
     the full tuple, derived forms) rank above aliases (name, alias attributes, the CI's own ref values).
   - **Resolution.** A ref value resolves when exactly one CI of the ref's target types carries it at the best rank
     present. It is deterministic for a given set of CIs, whatever order they arrived in. An ambiguous value resolves to
     nothing.
   - **Ref key.** The ref key is the tuple with each ref replaced by `@<ci id>`. It identifies alongside the raw tuple
     and the scoped global keys. When an observation's refs resolve, its ref key stands in for its raw tuple.
3. **Store (migration 0028).** `cis` gains four columns:
   - `refTokens`: GIN-indexed; the lookup finds the CIs a result's refs may name in one probe per chunk.
   - `refKey`: btree-indexed with the tenant.
   - `refsPending` and `refsCheckedAt`: partial index on pending rows.

   A trigger handles writers other than the reconciler, such as the onboarding wizard and the commercial register:
   - a CI such a writer inserts, or whose identity it changes, is left pending;
   - a CI whose identity, name or attributes such a writer changes loses its tokens.

   The reconciler marks its own transactions with `set_config('openmap.ref_tokens', 'reconciler', true)`. The migration
   marks every current CI pending once.
4. **Order independence.** The reconciler:
   - reconciles a result in ref-depth order, so a listener can name a host the same result reports;
   - runs a ref pass ahead of the pending-relationship retry, after every result and at the end of a replay. The pass:
     1. computes missing tokens;
     2. retries pending refs, round robin;
     3. folds CIs that now share a ref key.

   After each result it also folds any CI it created under a ref key another current CI holds. Folding keeps the
   oldest CI. The newer one's identity, attributes (by the merge rules), tags, relationships, parts, external ids and
   asset record move to the survivor. The newer one is retired (`openmap.ci.retired` with `mergedInto`). CIs whose
   ref key named it go back to pending and resolve to the survivor.
5. **Collector.** NGINX keyed upstream members `protocol: "http"`. Every other observer keys a listener by its
   transport, so NGINX now uses `tcp` and keeps `applicationProtocol: "http"` as an attribute (T-455).

## Consequences

- Simulated mode reports identity drift 0 (from 284). All `listening_service` pool members now resolve through the
  member's IP or FQDN to the VM or host the estate keys them by (`docs/evidence/simulated-mode.md`).
- Two estate CIs never merge with each other under these rules. T-450 checks the generated estate and T-454 checks the
  checked-in synth-small. The dev replay creates exactly the estate's CI count, with no updates.
- Costs added to reconciliation:
  - **Lookup:** one indexed token probe per result that carries refs, plus a ref-key probe.
  - **Pending pass:** two bounded queries that are index-only when nothing is pending
    (`RECONCILER.pendingRefBatch`, `refTokenBackfillBatch`).
  - **Folding:** one grouped probe per result over the result's own ref keys.
- An ambiguous ref (two hosts behind one address, a VRF name) stays unresolved and compares as written, as before.
  Resolution never guesses.
- The collector contract moves to 0.7.0 with the CI contract (the Go `contract.Version` is checked against both). No
  payload field changed.
