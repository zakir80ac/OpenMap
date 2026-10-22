# ADR-008 — Protocol libraries for the Go collectors

**Status:** Proposed (needs Syed's confirmation) · **Date:** 2026-10-22 · **Requirements:** REQ-DISC-002, 006, 021, 023, 024

## Context

CLAUDE.md forbids fabricating device behaviour and requires every dependency outside the component table to be recorded. The collector families added this session speak protocols that are impractical to implement from scratch inside the release window, and whose reference implementations are permissively licensed, widely deployed and still maintained.

## Decision

Add the following Go modules to `apps/collectors` (all pure Go, statically linkable, no CGO, so the Node image stays distroless):

| Module | Licence | Used by | Why this one |
| --- | --- | --- | --- |
| `github.com/masterzen/winrm` (+ `bodgit/ntlmssp`, `jcmturner/gokrb5`) | Apache-2.0 | `wmi`, `hyperv`, `dhcp` (Windows mode) | WS-Man with NTLM and Kerberos message encryption, the only maintained Go WinRM client used by Terraform, Packer and Ansible tooling |
| `github.com/miekg/dns` | BSD-3-Clause | `dns` | AXFR/IXFR, TSIG, the de-facto Go DNS library (CoreDNS) |
| `github.com/go-ldap/ldap/v3` | MIT | `ldap` | Paged LDAP searches, StartTLS, AD controls |
| `github.com/jackc/pgx/v5` | MIT | `database` | PostgreSQL wire protocol without CGO |
| `github.com/go-sql-driver/mysql` | MPL-2.0 | `database` | MySQL/MariaDB driver; file-level copyleft only, no linking obligation |
| `github.com/microsoft/go-mssqldb` | BSD-3-Clause | `database` | TDS driver maintained by Microsoft |
| `go.mongodb.org/mongo-driver/v2` | Apache-2.0 | `database` | Official MongoDB driver |
| `github.com/redis/go-redis/v9` | BSD-2-Clause | `database` | RESP client compatible with Valkey |

Already recorded elsewhere: `gosnmp` (snmp), `golang.org/x/crypto/ssh` (ssh runners). AWS SigV4, S3 XML, Redfish, vSphere REST, Prism, iControl, ONTAP, FlashArray, oVirt and ARM are implemented over `net/http` in-repo (`internal/restjson`, `internal/sigv4`) precisely to avoid cloud SDKs and their transitive weight.

## Consequences

- Node image grows by roughly 60 MB (database drivers dominate); still a single static binary per collector.
- Every library is exercised only through protocol-shaped fixtures in unit tests; vendor recordings (risk R-004) remain required before a family reaches Done.
- Licence notices are carried in the SBOM generated at release time; MPL-2.0 (MySQL driver) is compatible with Apache-2.0 distribution because the module is linked, not modified.
