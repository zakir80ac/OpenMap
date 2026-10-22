# ADR-004 — Twelve-layer model with user-labelled unknowns

Status: Accepted · Date: 2026-10-22 · Tracker: CMDB "Layers" rows

## Context

Syed asked for layered visibility: DC, network and security, hardware (iLO, iDRAC, BMC), storage (FC fabric, SAN, NAS, object), virtualization (vCenter, Hyper-V, Azure, KVM, Nutanix AHV, Oracle VM), containers, applications, databases, then added OS, cloud and SaaS assets, plus an "unknown" bucket users can label and describe.

## Decision

`CI_LAYERS` = dc, network_security, hardware, storage, virtualization, cloud, os, containers, databases, applications, saas, unknown. Every CI type has a default layer (`CI_TYPE_LAYER`). A `userLabel` on a CI overrides the layer and may reclassify the type; labelling emits `openmap.ci.labelled`. Layer visibility is a per-user setting applied on every screen and in the dependency map. Cross-cutting records (software, licences, vulnerabilities, vendors, contracts) attach to the layer of the CI they describe and are listed under applications when standalone.

## Consequences

Layer counts become a first-class metric. New CI types must declare a layer or the contracts test fails.
