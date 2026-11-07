# ADR-042 — Simulated mode for vendor integrations

Status: Accepted (REQ-QA-005, 2026-11-07) · Date: 2026-11-07 · Tracker: REQ-QA-005

## Context

On 2026-11-07 Syed parked 28 rows that need real vendor access: 25 discovery families waiting on licensed products or
hardware, REQ-DISC-004/031 waiting on the code-signing decision, SaaS tenants (REQ-CMDB-022) and vendor warranty and
EoX APIs (REQ-CMDB-024). He asked for a simulated mode so the solution can be tested end to end until that access
arrives. Two things stay true while the rows are parked:

- A vendor fixture is captured from a real product, never written by hand (risk R-004). A response we wrote
  ourselves proves only that the collector and our reading of the vendor documentation agree.
- The synthetic estate (tools/synth-estate) already drives the pipeline from the collector contract inward. It does
  not exercise the collectors themselves: their auth, paging, TLS handling and parsing.

## Decision

1. `tools/simulator` (Go module in the workspace) serves each parked vendor's API on loopback. It renders every
   response from the synthetic estate and follows the vendor's published API documentation and the collector's
   parser. It uses real authentication (a per-process secret, sessions and tokens) and real paging, and serves TLS
   under a throwaway per-process CA that collectors pin with `caCertPem` and `verifyTls=true`. Products whose API is
   not HTTP get a protocol server (SNMP agent, SSH, WinRM, LDAP, DNS, flow exporter, TCP banners).
2. `simulator verify` builds the real collector binary from `apps/collectors`. It pipes in the same contract
   Invocation a Discovery Node sends and compares the Result with the estate on three points:
   - every expected CI, matched by type and name;
   - every expected relationship, between emitted CIs or to reference-only CIs matched by identity;
   - identity drift: matched CIs whose collector identity would not merge with the estate's CI.

   Each vendor package carries a Go test on this harness (T-350 onward).
3. `simulator serve` keeps the simulators up and writes a job plan (targets, options, simulated credentials), so a
   real Discovery Node and the full stack can run the same jobs.
4. Simulated runs are labelled `provenance: simulated` (reports, evidence, CA subject) and never close a vendor row.
   Parked rows stay Blocked with the reason in their notes. When access arrives, recorded fixtures replace the
   simulator as the evidence.
5. Gaps the simulator exposes in a collector are fixed in the collector with a regression test. The first was token
   and login transports ignoring `caCertPem` (`restjson.TransportFor`, T-351).
6. Simulator data never reaches `packages/testing/fixtures/vendor` and is never committed as a capture.

## Consequences

- Every collector path for a parked vendor runs for real in CI-like conditions: login, TLS, paging and parsing.
- Drift between the synthetic estate and real collector identities becomes visible. The first example is Pure LUN
  WWNs, which the estate generates without the `624a9370` IEEE prefix. Such drift is reported, not hidden.
- The simulator is our reading of the vendor documentation. A vendor-side difference will only show up against the
  real product, which is why the rows stay parked.
