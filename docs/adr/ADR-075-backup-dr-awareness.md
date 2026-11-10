# ADR-075 — Backup and DR awareness: backup policies as CIs, `backed_by` covers, RPO judged against the services

Status: Accepted · Date: 2026-11-10 · Tracker: REQ-INT-017 · Contracts: CI 0.14.0, collector 0.14.0, GraphQL 1.47.0

## Context

CAPABILITY-MAP.md asks for backup and DR awareness on a par with Device42: which CIs a backup product protects, by what,
when the last good backup ran, and which critical CIs nothing protects. The estate's backup products are Veeam Backup &
Replication, Commvault and Rubrik CDM. The contract already had `backed_by` as an impact edge (an application component
backed by its database cluster), but no CI for a backup policy, no collector family and nothing that judged an RPO.

No Veeam, Commvault or Rubrik system is available (Syed's decision of 2026-11-07 parks vendor rows until there is real
access; risk R-004 forbids fabricated fixtures), so the adapters are written against the vendors' published REST API
references and exercised in simulated mode (ADR-042).

## Decision

1. **A backup policy is a CI.** New CI type `backup_policy` (storage layer), identity `vendor`, `serverId`, `policyId`:
   a Veeam job, a Commvault plan (or, for a subclient without a plan, its storage policy), a Rubrik SLA domain. Its
   attributes (`protection.ts` `BACKUP_POLICY_ATTRIBUTES`) carry the kind, the RPO the schedule can meet, the
   retention, the last run and result, and how many protected objects were matched and not matched. No identity key
   is globally unique: two servers can both have a job 1.
2. **A cover is a `backed_by` edge** from the protected CI to the policy, carrying the object's last good backup (the
   newest restore point, snapshot or completed job), its result, restore points and, for Commvault, the agents and
   subclients (`BACKUP_COVER_ATTRIBUTES`). Only `backed_by` edges whose target is a `backup_policy` are covers; the
   existing storage meaning (component → database cluster) is left as it is.
3. **One collector family `backup`, one job per backup server**, with vendor adapters:
   - Veeam REST v1: OAuth2 password grant, `x-api-version` on every call, `serverInfo` (vbrId), jobs and job states,
     backups, their objects and restore points, skip/limit paging; RPO from the daily, periodic or monthly schedule,
     retention in days or restore points.
   - Commvault Command Center REST: Base64 login and `Authtoken`, clients, subclients per client, v2 plans (RPO,
     retention) and backup job history (last completed job per subclient).
   - Rubrik CDM: service-account session (an `oauth_client` credential), cluster id, SLA domains (RPO from the
     shortest frequency, retention from the longest), vCenters, VMs with paging and their snapshots, filesets per host.
4. **Objects are matched to the CMDB through the job's inventory.** Veeam and Rubrik name a VM by its vCenter and
   managed object id, Commvault a client by name and host name; none reports the VMware instance UUID the vmware
   collector keys VMs on. The planner (`scheduler backup:plan`) therefore puts the CMDB's VMs and hosts in the job
   (`inventory`: type, the identity the CMDB stores, and every lower-case key a product may use: name, FQDN, address,
   instance UUID, `<vcenter>:<moRef>`), and the collector names a matched object by that stored identity, so the
   reconciler resolves the edge with the existing identity rules. An object the inventory does not hold is named by its
   FQDN when it has one (the reconciler parks it as pending until a CI carries that FQDN), otherwise counted on the
   policy as unmatched. Ambiguous keys are dropped rather than guessed.
5. **Protection is judged, not stored.** `judgeProtection` (contract): no cover is *unprotected*; a cover whose newest
   good backup is older than the target RPO, or that has none, is *RPO breached*; otherwise *protected*. The target is
   the strictest of the covering policies' RPOs and the `rpoMinutes` of the business services the CI supports (found by
   the impact walk), else `BACKUP_AWARENESS.defaultRpoMinutes` (a day). A database or database cluster without a cover
   of its own inherits the covers of the compute it is hosted on whose agents include a database agent: an image-level
   VM backup is not an application-consistent database backup.
6. **Gaps.** `protectionGaps(maxTier)` takes the business services of tier `maxTier` or more critical (default
   `criticalMaxTier` = 2), walks from their members down `contains` (logical containers only), `depends_on`, `runs_on`
   and `hosted_on` (breadth first, `supportWalkDepth` hops) to VMs, hosts, databases and database clusters, judges each
   and lists the unprotected, then the RPO breached, by service tier and name.
7. **API and console.** Queries `ciProtection(ciId)` (null for a type no backup protects) and `protectionGaps`; span
   `bsm.protection.ci` / `bsm.protection.gaps`, counter `openmap_protection_reads_total{query}`. The console shows a
   Protection card on the CI detail and a Protection screen listing the gaps, in English and Arabic.

## Consequences

- Migration 0052 adds the `CiType` and `CollectorFamily` values; Memgraph 0005 the `:BackupPolicy` label index.
- Simulated mode: `veeam-backup-replication`, `commvault-command-center` and `rubrik-cdm` simulators render the
  synthetic estate's new backup stream (11 policies, 2,231 covers at seed 42, scale 0.05); results are labelled
  `simulated` and close nothing. The tracker row stays Blocked until a real Veeam, Commvault or Rubrik system can be
  reached and a capture recorded.
- The estate's backup times are relative to its epoch, so on a replayed tenant the covers read as past their RPO when
  judged against today; that is what a stale collection looks like, and a fresh sweep clears it.
- The job inventory grows with the estate (a few hundred bytes per VM or host). At the scale target (70k VMs and hosts)
  that is a large job document; if it becomes a problem the planner can split it by vCenter or site.
- Not covered: Veeam agent jobs for physical machines, Commvault virtual-server (VSA) subclients and Rubrik databases
  (SQL Server, Oracle) as objects of their own. They need API shapes we have not built against yet.
