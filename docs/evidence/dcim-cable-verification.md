# Cable verification and labels (REQ-DCIM-008, ADR-062)

Captured 2026-11-10 on the dev compose stack with the synthetic estate. The estate's tenants hold LLDP adjacencies
between switch ports and server NICs on switch ports, but no recorded cables yet, so on the live screen every
observed link is undocumented; the integration test seeds recorded cables to exercise every verdict.

## What the Cabling tab shows

- **Five totals**: recorded cables verified by discovery (of all recorded), mismatches, not observed, not verifiable,
  and observed links with no recorded cable.
- **Verdicts**, the ones to act on first: a mismatch names the link discovery saw instead; the others say why
  (no observed neighbour on either end, the path stops at an unpatched panel side, an end is not a device port).
- **Undocumented links**, the first 200 by device and port, each with the label a recorded cable would get
  (`device:port - device:port`), how it was seen and its speed. An operator's Record button fills the cable form with
  that label and both device ports; saving goes through the existing audited `connectCable`.
- **Labels**: a CSV download (label, kind, media, both ends with port and panel side, length, colour, verdict).

## Where the verdicts come from

| Side                                 | Source                                                                                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Recorded                             | ADR-056 cables and circuits, each traced from both ends through the patch panels to the first device port (`traceCable`)                      |
| Observed, switch to switch           | `connected_to` between two `interface` CIs (SNMP LLDP/CDP), each interface's device from its `contains` parent                                |
| Observed, switch to neighbour device | `connected_to` from an interface to a device, the far port from `remotePortId`                                                                |
| Observed, server NIC                 | `cabled_to` from a host to a switch interface, the NIC from `hostNic`                                                                         |
| Verdict                              | `verifyCabling` in `packages/contracts/src/cabling-verify.ts`: verified, mismatch, unobserved, unverifiable; observed links indexed by device |

Timing of one verification read on the dev stack (no recorded cables, so the full adjacency set is listed as
undocumented, the worst case):

| Tenant adjacencies | First read | Second read |
| ------------------ | ---------- | ----------- |
| 88,854             | 1.71 s     | 1.61 s      |
| 22,255             | 0.54 s     | 0.61 s      |
| 4,327              | 0.10 s     | 0.09 s      |

## Tests

| Test                                                                       | What it proves                                                                                                                                                                                                                                                                                                      | Result                       |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `packages/contracts/src/cabling-verify.test.ts` (T-550)                    | port matching with and without a port, links deduplicated either way round, every verdict and reason, undocumented links, the summary, the label length                                                                                                                                                             | 3 passed (contracts 85)      |
| `apps/api/src/cabling/cabling-verify.integration.test.ts` (T-551)          | on the compose stack: a direct lead verified by LLDP, a server lead verified by `cabled_to`, a lead to the wrong switch named as a mismatch with what was seen, a three-cable path through two panels unobserved, a lead into an unpatched panel unverifiable, the undocumented link with its label, the labels CSV | 2 passed                     |
| `apps/console/src/components/dcim/CableVerificationPanel.test.tsx` (T-552) | totals, verdict order and findings, undocumented links with speed, the Record action for operators only, the labels download, in en and ar                                                                                                                                                                          | 5 passed                     |
| `apps/console/src/components/dcim/CablingView.test.tsx` (T-553)            | Record fills the cable form with the observed label and both device ports, and saving sends them to `connectCable`, in en and ar                                                                                                                                                                                    | 6 passed                     |
| `apps/console/e2e/screens.spec.ts` (DCIM)                                  | the verification card on the live stack, the undocumented links, the labels download as `openmap-cable-labels.csv`, screenshots `dcim-cabling-verify-{en,ar}.png`                                                                                                                                                   | 3 of 3 (setup, en, ar), 13 s |

Guard ok; `contracts:check` GraphQL 1.35.0 additive; i18n in sync (27 keys per locale).
