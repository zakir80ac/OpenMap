# ADR-040 — Oracle Database driver for the database collector

**Status:** Accepted · **Date:** 2026-11-07 · **Tracker:** REQ-DISC-024

## Context

REQ-DISC-024 names Oracle Database among the engines the database collector discovers, but the collector
only had probers for PostgreSQL, MySQL/MariaDB, SQL Server, MongoDB and Redis/Valkey (ADR-008). Oracle's
wire protocol (TNS with the O5LOGON authentication and TTC call layer) is undocumented, so a client written
from scratch is not realistic. The collector runs on the Discovery Node, which is a distroless image built
without CGO and must work air-gapped (CLAUDE.md §1.7). It must not depend on a product that has to be
installed alongside it (§1.6).

## Decision

Add `github.com/sijms/go-ora/v2` (v2.9.0, MIT licence) to `apps/collectors` as a library linked into the
`database` collector binary. It is a pure-Go implementation of TNS/TTC, used through `database/sql`.

- `internal/database/oracle.go` registers the engine `oracle` (default port 1521, protocol `tns`). It runs
  read-only queries over the dynamic performance views: `v$instance`, `v$version`, `v$database`,
  `v$session`, `v$parameter`, `nls_database_parameters`, `v$datafile`, `v$pdbs` and `v$archive_dest`.
  These need only CREATE SESSION and SELECT_CATALOG_ROLE. A query the account may not run is recorded as
  refused and skipped.
- The probe is split in two: "run the queries and keep the text rows" and a pure "rows to inventory"
  function. Queries convert every column to text in SQL, so the recorded evidence holds exactly what the
  server returned.
- The service name comes from the job's `database` option. When it is absent the default is DBCA's `ORCL`.

## Alternatives considered

- **`github.com/godror/godror`** (Apache-2.0/UPL). Rejected. It wraps ODPI-C through CGO and needs the
  Oracle Instant Client libraries at run time. That breaks the static, distroless Node image. It adds a
  proprietary runtime that must be downloaded from Oracle under its licence, which is not sovereign and
  not air-gap friendly by default.
- **ODBC or JDBC bridges.** Rejected for the same reason: they add a driver runtime outside the collector
  binary.
- **Leaving Oracle out of REQ-DISC-024.** Rejected. Oracle is in the requirement title and is common in
  the target estates.

## Consequences

- The `database` binary grows by the size of go-ora. The module has no transitive runtime dependencies in
  this build; the modules its own go.mod lists serve its tests and ORM adapters only.
- Oracle Native Network Encryption and data integrity are negotiated by the driver when the server
  requires them. TLS (TCPS) is used when the job sets `tls`.
- The driver's server-response verification in O5LOGON is not performed by go-ora. The collector only
  reads, so a spoofed listener can at most return a false inventory. Jobs should use TCPS where the network
  is untrusted.
- Vendor recordings: the Oracle Database Free fixture
  (`packages/testing/fixtures/vendor/database/oracle-database-free-*`, test T-319) satisfies risk R-004 for
  this engine.
- The licence notice is carried in the release SBOM. The Components sheet row is added through the
  tracker CLI, not by this ADR.
