# ADR-062 — Cable verification: recorded cables judged against observed adjacencies, with printable labels

Status: Accepted · Date: 2026-11-10 · Tracker: REQ-DCIM-008 · Contracts: GraphQL 1.35.0

## Context

CAPABILITY-MAP.md §4 lists "cable management with labels and verification" (cables with LLDP verification status).
ADR-056 (REQ-DCIM-001) gave people a way to record patch panels, cables, trunks, cross-connects and circuits, and
noted that comparing them with what discovery observes was this requirement. Discovery already holds the other side:
the SNMP collector emits LLDP and CDP adjacencies as `connected_to` between switch interfaces (or from an interface to
the neighbour device with its remote port id), and host collectors emit a server NIC on a switch port as `cabled_to`.
On the dev estate that is about 89,000 adjacencies on the largest tenant.

## Decision

1. **A recorded cable is judged by the device ports its path joins.** Each cable is traced from both ends through
   the patch panels (the ADR-056 trace) to the first port that is not a panel position. The verdict, computed by
   `verifyCabling` in `packages/contracts/src/cabling-verify.ts` and shared with the tests:
   - **verified**: an observed adjacency joins the two far ends;
   - **mismatch**: an observed adjacency touches one far end but leads somewhere else (the verdict names what was seen);
   - **unobserved**: neither far end has an observed neighbour;
   - **unverifiable**: the path stops at a panel side with nothing patched, loops, or an end is not a device port.

   Ports compare by device and case-insensitive port name; a reference without a port (a cable recorded to a device)
   matches any port of that device.

2. **Observed links nothing recorded explains are undocumented.** They are counted in full and the first
   `CABLING.undocumentedLimit` (200) are listed by device and port, each with the label a recorded cable would get
   (`device:port - device:port`, cut to `CABLING.labelMaxChars`). An operator records a cable from one: the cable form
   opens filled with that label and both device ports.
3. **One SQL read of the observations.** The adjacencies, both ends and the device containing each interface are read
   in a single join (tens of thousands of ids do not fit a bound IN list); observed links are indexed by device so a
   path only ever looks at its two devices. Measured on the dev stack: 1.6–1.7 s for 88,854 adjacencies, 0.5 s for
   22,255, 0.1 s for 4,327, with no recorded cables (every adjacency undocumented, the worst case for the listing).
4. **Labels are a CSV download** (`cablingLabelsCsv`): label, kind, media, both ends (device, port, panel side),
   length, colour and verdict, one cable per line, ready for a label printer's import.
5. **Nothing is written.** Verification is a read; it changes no cable and no CI. Recording a cable from an observed
   link goes through the existing `connectCable` mutation, audited as before.

## Consequences

- GraphQL 1.35.0 (additive): `CableVerificationStatus`, `CableVerificationReason`, `ObservedPort`, `ObservedLink`,
  `CableVerification`, `CablingVerificationSummary`, `CablingVerification`; queries `cablingVerification`,
  `cablingLabelsCsv`. Prometheus `openmap_cabling_verifications_total`; span `cabling.verify`.
- The Cabling tab gains the verification card above the panels: five totals, the verdicts (mismatches first), the
  undocumented links with a Record action for operators, and the labels download.
- A port that discovery cannot see (a server without an agent behind an unmanaged switch) stays unobserved; that is
  the honest answer, not a failure.
- Future: verdicts per site for very large tenants, and a scheduled verification that raises a finding when a
  verified cable turns into a mismatch.
