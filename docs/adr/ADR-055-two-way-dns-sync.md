# ADR-055 — Two-way DNS sync: zones kept in sync with their authoritative server

Status: Accepted (REQ-IPAM-003, 2026-11-08) · Date: 2026-11-08 · Tracker: REQ-IPAM-003 · Contract: GraphQL 1.28.0

## Context

REQ-IPAM-003 asks for DNS zone and record sync with the authoritative servers, both ways. OpenMap already read zones:
the DNS collector (`apps/collectors/internal/dnszone`) transfers a zone (AXFR) and reports it as a `dns_zone` CI with
its `dns_record` CIs. Two things were missing:

- a record removed from the zone stayed current in the CMDB;
- a person could not change a record from OpenMap.

## Decision

1. **A full transfer is a complete snapshot.** The DNS collector marks a transferred zone `attributes.transfer = axfr`.
   After such a result lands, the reconciler (`apps/reconciler/src/worker/zones.ts`) retires the zone's current
   `dns_record` CIs that the transfer no longer holds. It also retires the relationships that touch them, emitting the
   usual `ci.retired` and `relationship.retired` events with `by: zone-transfer`. A record deleted on the server, or
   changed there, therefore leaves the CMDB at the next transfer; a changed record is replaced by the new one.
2. **Writes are RFC 2136 dynamic updates, signed with TSIG.** OpenMap does not hold the zone file. It asks the server to
   change the zone, so the server stays the authority and its own validation, serial handling and notifies apply.
   - The collector's `updates` option carries `{zone, op add|delete, name, type, value, ttl}`.
   - The Node sends one UPDATE message per zone over TCP, before that zone's transfer.
   - REFUSED, NOTAUTH and BADSIG are reported as permission denied, naming the zone.
   - The TSIG secret is a credential set of type `api_token`, resolved from OpenBao on the Node like every other
     credential. It is never in the job.
3. **Zones kept in sync and record changes are tenant data.** Migration 0039 adds two tables:
   - `dns_zone_syncs`: zone, server, port, TSIG key name and algorithm, credential reference, site, enabled, last pull,
     last push, last job and last error.
   - `dns_changes`: zone, op, name, type, value, TTL, state, job, error, who and when.

   Contracts (`packages/contracts/src/dns-sync.ts`) validate a change: A takes IPv4, AAAA takes IPv6, and the name must
   fall inside the zone. The settling rule `settleDnsChange` is pure.
4. **The scheduler runs the sync loop** (`DNS_SYNC_INTERVAL_MS`, default 30 s). Each round, `planDnsSync` gives a zone a
   DNS job on a Node at the zone's site when the zone has pending changes or its pull is due (`DNS_PULL_INTERVAL_MS`,
   default 15 min). A zone whose job is still running is skipped. The job's changes turn `sent`, with the job's id.
5. **The transfer that follows is the confirmation.** When the job completes, `settleDnsJob` compares each sent change
   with the records the transfer returned:
   - an add is `applied` when the record is there;
   - a delete is `applied` when it is gone;
   - otherwise the change is `failed`, with the collector's error or "not in the transfer".

   A job that fails fails its changes with the job's error. A job left unfinished for longer than
   `DNS_SYNC.staleJobMs` no longer holds its zone back from the next round. Nothing is reported applied on the strength
   of the update's own answer alone.
6. **API and screen.**
   - GraphQL 1.28.0 adds:
     - `DnsZoneSync`, `DnsChange`, `DnsZoneSyncInput` and `DnsChangeInput`;
     - queries `dnsZoneSyncs` and `dnsChanges(zone, limit)`;
     - `upsertDnsZoneSync` (administrator; the site must be the tenant's);
     - `requestDnsChange` (operator; refused unless the zone is kept in sync; names are made absolute).
   - Each mutation writes an audit event. `openmap_dns_changes_total` counts the requests, and each one runs in a
     `dns.change.request` span.
   - The IPAM DNS tab gains a DNS sync panel:
     - the zones kept in sync, with server, site, last transfer, last push and changes on their way;
     - a form for administrators to keep a zone in sync;
     - a change request form for operators;
     - the record changes with their state, refreshed while any change is on its way.
7. **The lab** (compose profile `lab`) runs ISC BIND 9 as `dns-lab`, serving `lab.openmap.test`. It allows transfer and
   update only under the TSIG key `openmap-sync`, whose secret is `DNS_LAB_TSIG_SECRET` in the gitignored `.env`. The
   e2e (T-519) exercises the whole loop against it: an A record is added from the screen, turns Applied and appears
   among the DNS records; it is then deleted the same way, turns Applied and is retired from the CMDB.

## Consequences

- A record is confirmed only by a transfer, so a change takes up to one sync round plus the Node's job to settle.
  Requesting it does not make it current.
- Servers that refuse AXFR to OpenMap cannot be kept in sync. Their zones can still be read through the server APIs
  where a collector supports them, but there are no retirements by snapshot.
- Removal by snapshot applies only to complete transfers (`axfr`). A partial read (an API page, a future IXFR) never
  retires records.
- Additions only to the contracts: GraphQL 1.27.0 → 1.28.0.
