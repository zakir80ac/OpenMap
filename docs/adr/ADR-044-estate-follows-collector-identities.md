# ADR-044 — The synthetic estate identifies and links CIs the way the collectors do

Status: Accepted (REQ-QA-001, REQ-QA-005, 2026-11-07) · Date: 2026-11-07 · Tracker: REQ-QA-001, REQ-QA-005

## Context

Simulated mode (ADR-042) showed the synthetic estate identifying many CIs differently from the real collectors (STATE
question 04). Real discovery against such an estate adds a second CI instead of updating the estate's. Syed's answer
on 2026-11-07: align the estate with the collectors.

The first count, 36,373 drifted CIs, came from a harness check stricter than the reconciler: it flagged any shared key
with a different value. Reconciliation (REQ-CORE-013, `apps/reconciler/src/core/identity.ts`) merges an observation
into a stored CI when the full identity tuple is equal, or when any globally unique key carries the same value. Judged
that way, the estate drifted in 7,894 CIs, and 524 relationships linked the same two CIs with another type or
direction.

## Decision

1. **The harness judges a merge as the reconciler does.** `packages/contracts` emits `schemas/ci-identity.json`
   (`CI_IDENTITY_KEYS`, `GLOBAL_IDENTITY_KEYS`), and `tools/simulator` reads it. The harness also:
   - rewrites identities a collector derived from the loopback address it dialled into the estate's name for that
     target (`Run.Aliases`: vCenter moRefs, BMC and DHCP server addresses, bucket endpoints);
   - pairs a CI with the same-named candidate that merges (many OS CIs share a name);
   - reports relationship drift: an emitted link between two estate CIs that the estate links with another type or
     direction, where the collector does not also report the estate's own link.
2. **The estate adopts the collectors' conventions.** It generates:
   - **Network-device children:** `deviceRef` is `serial:<serial>` (SNMP).
   - **Hypervisors:**
     - `hostRef` is the host FQDN.
     - `moRef` is the platform's id: `<vcenter>:host-<n>`, Prism's host UUID, or the server's SMBIOS UUID.
     - `hypervisor hosted_on host`.
   - **VMs:** `vm runs_on hypervisor`, with `hypervisorRef` set to the hypervisor's host FQDN.
   - **Clusters:** `clusterId` is `<vcenter>:domain-c<n>`, Prism's cluster UUID or Hyper-V's cluster GUID.
   - **Operating systems:** `installed_on` the host. A Windows OS identity carries its build (`10.0.20348`); the year
     stays in `name` and `version`, where lifecycle matching reads it.
   - **Software:** each `software_instance` names its software `name@version` and is `member_of` it.
   - **DNS:** CNAME targets are absolute (trailing dot).
   - **LUNs:** WWNs are NAA-6 with the array vendor's OUI (`naa.624a9370…` Pure, `naa.600a0980…` NetApp).
   - **FC fabrics:** each is named by its principal switch's WWN.
   - **AWS:** ARNs follow each service's form (`rds:…:db:<name>`, `lambda:…:function:<name>`, `…/<id>` elsewhere).
   - **SaaS:**
     - Tenant ids are shaped as each vendor issues them.
     - Products are identified by the name the vendor API reports: Graph's SKU part number, `Google Workspace`,
       `Workday HCM`.
   - **Kubernetes:** a Service `depends_on` the workloads its selector matches, and each tier is labelled by its
     component.
3. **Where the collectors disagreed, the majority form was adopted, and the outliers were changed:**
   - **SSH:** an OS is `installed_on` its host, not `runs_on`.
   - **WMI:** an instance is `installed_on` the host, not `hosted_on`. The software link is `instance member_of
     software`, not `software installed_on instance`.
   - **SSH and the agent:** both now emit `member_of` too. Before, neither linked an instance to its software, so
     vulnerability queries ("which hosts run affected software") found no hosts on discovered data.
   - **Agent:** `softwareRef` is `name@version`, as SSH and WMI write it.
4. **Simulators serve the estate's ids** (cluster and host moRefs, cluster UUIDs and GUIDs, ARNs, SaaS tenants) instead
   of deriving their own, so the estate is the one source the collector must reconcile to.
5. **The assistant's grounding follows the stored directions:**
   - `Vm RUNS_ON Hypervisor`;
   - `Hypervisor HOSTED_ON Host`;
   - `OperatingSystem INSTALLED_ON Host`.

   The application map, impact traversal and dependency layout treat `runs_on` and `hosted_on` alike and need no
   change.

## Consequences

- With these changes, identity drift falls from 7,894 to 284 and relationship drift from 524 to 0, and all 495 runs
  still pass (`docs/evidence/simulated-mode.md`). T-450 pins the conventions in the generator.
- The remaining 284 are load-balancer pool members (`listening_service`). A load balancer names a member by its IP or
  FQDN, while the host's own collector names its listener by the host serial. One estate value cannot match both
  observers. Closing this needs reconciliation to resolve `*Ref` values to the referenced CI, which is a product
  change, not an estate one. ADR-045 made that change; identity drift is now 0.
- Estates generated before this ADR keep their old identities. Dev stacks should replay a regenerated estate with
  `--reset`.
