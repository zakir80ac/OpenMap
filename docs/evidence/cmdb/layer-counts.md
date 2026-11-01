# REQ-CMDB-001 … REQ-CMDB-012 — layer counts match the synthetic estate (2026-11-01)

A clean replay of the scale-0.05 synthetic estate (seed 42, 28,203 CIs, 66,447 relationships) into
an emptied tenant (`pnpm --filter @openmap/reconciler replay --dir <estate> --reset`) produced exactly the layer counts the
generator reports in `estate-summary.json`; the graph summary is what `layers` serves to the console.

| Layer | Graph after replay | Estate summary | Match |
| --- | --- | --- | --- |
| applications | 3491 | 3491 | yes |
| cloud | 14 | 14 | yes |
| containers | 32 | 32 | yes |
| databases | 53 | 53 | yes |
| dc | 349 | 349 | yes |
| hardware | 4000 | 4000 | yes |
| network_security | 16366 | 16366 | yes |
| os | 2000 | 2000 | yes |
| storage | 252 | 252 | yes |
| unknown | 11 | 11 | yes |
| virtualization | 1635 | 1635 | yes |
| **total** | **28,203** | **28,203** | **yes** |

The first replay found three fewer `dc` CIs: the generator scoped rows and racks by the room's short name (`DH01`),
which repeats across sites, so three rows collided on the contract identity `(roomRef, name)` and were merged. The
generator now uses the tenant-wide room name (`RYD-DH01`); the tracker records the defect under REQ-CMDB-001 notes.

Visibility: the Layers screen's toggle applies to the dependency map (lane bridging, T-060) and, since commit
6e6a055, to every CI list — a hidden layer leaves `cis` until shown again; an explicit `layers` filter still reaches
it (T-032 'summarises layers from the graph and persists per-user visibility').
