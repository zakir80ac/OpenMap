# ADR-003 — Go for the Discovery Node and collectors

Status: Accepted · Date: 2026-10-22 · Tracker: DISC workstream

## Context

Syed asked whether Rust would be better than Go for the discovery runtime. The collectors depend on mature protocol libraries: SNMP (`gosnmp`), SSH, NetFlow/IPFIX/sFlow decoders, Kubernetes `client-go`, Redfish and IPMI, cloud SDKs, WinRM. Build speed matters for a 26-family collector tree.

## Decision

Keep Go 1.23+ as CLAUDE.md states. Rust is declined for the runtime. It remains an option for a future WASM hot path in the console (graph layout) if profiling shows a need; that would be a separate ADR.

## Consequences

Go must be installed on build machines (risk R-002). JSON Schema emitted from `packages/contracts` is the interface Go code validates against.
