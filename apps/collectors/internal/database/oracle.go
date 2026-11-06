// REQ-DISC-024 — Oracle Database probe (pure-Go TNS driver go-ora, ADR-040): instance, version and
// edition, DBID and Data Guard role from v$database, sessions against the sessions parameter, the
// CDB root and every pluggable database with its datafile size, and Data Guard standby destinations.
// Every query reads dynamic performance views only, so an account with CREATE SESSION and
// SELECT_CATALOG_ROLE is enough; a query the account may not run is skipped, not fatal.
package database

import (
	"context"
	"database/sql"
	"strconv"
	"strings"

	goora "github.com/sijms/go-ora/v2"
)

const (
	// DBCA's default global database name; jobs name the real service in options.database.
	oracleDefaultService = "ORCL"
	oracleDriverName     = "oracle"
	oracleProgramName    = "openmap-discovery"
	// v$datafile con_id 1 is the CDB root; the read-only seed template PDB is not a database.
	oracleRootConID = "1"
	oracleRootConNo = 1
	oracleSeedPDB   = "PDB$SEED"
	oracleYes       = "YES"
)

// The probe's queries, by name. Every column is converted to text in SQL so the recorded results keep
// exactly what the server returned and the inventory parses one representation.
var oracleQueries = []struct {
	Name     string
	SQL      string
	Required bool
}{
	{"instance", "SELECT instance_name, host_name, version, TO_CHAR(ROUND((SYSDATE - startup_time) * 86400)), status FROM v$instance", true},
	{"version_full", "SELECT version_full FROM v$instance", false},
	{"banner", "SELECT banner FROM v$version WHERE banner LIKE 'Oracle%'", false},
	{"database", "SELECT TO_CHAR(dbid), name, db_unique_name, database_role, open_mode, log_mode, cdb FROM v$database", false},
	{"sessions", "SELECT TO_CHAR(COUNT(*)) FROM v$session WHERE type = 'USER'", false},
	{"parameters", "SELECT name, value FROM v$parameter WHERE name IN ('sessions', 'processes', 'fal_server', 'db_domain') ORDER BY name", false},
	{"charset", "SELECT value FROM nls_database_parameters WHERE parameter = 'NLS_CHARACTERSET'", false},
	{"datafiles", "SELECT TO_CHAR(con_id), TO_CHAR(SUM(bytes)) FROM v$datafile GROUP BY con_id ORDER BY con_id", false},
	{"pdbs", "SELECT TO_CHAR(con_id), name, open_mode, TO_CHAR(total_size) FROM v$pdbs ORDER BY con_id", false},
	{"standby_dests", "SELECT dest_name, destination, status FROM v$archive_dest WHERE target = 'STANDBY' AND status <> 'INACTIVE' ORDER BY dest_id", false},
}

// oracleResult is one query's rows as text; a nil cell is SQL NULL. Err holds the server's refusal
// when the account may not run the query.
type oracleResult struct {
	Rows [][]*string `json:"rows"`
	Err  string      `json:"error,omitempty"`
}

type oracleProber struct{}

func (oracleProber) Probe(ctx context.Context, host string, port int, user, password string, tls bool, dbName string) (*Inventory, error) {
	opts := map[string]string{"PROGRAM": oracleProgramName}
	if tls {
		opts["SSL"] = "enable"
	}
	db, err := sql.Open(oracleDriverName, goora.BuildUrl(host, port, firstNonEmpty(dbName, oracleDefaultService), user, password, opts))
	if err != nil {
		return nil, err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	results, err := runOracleQueries(ctx, db)
	if err != nil {
		return nil, err
	}
	return oracleInventory(results)
}

// runOracleQueries runs every probe query on one session and keeps the text rows.
func runOracleQueries(ctx context.Context, db *sql.DB) (map[string]oracleResult, error) {
	out := map[string]oracleResult{}
	for _, q := range oracleQueries {
		rows, err := db.QueryContext(ctx, q.SQL)
		if err != nil {
			if q.Required {
				return nil, err
			}
			out[q.Name] = oracleResult{Err: err.Error()}
			continue
		}
		var res oracleResult
		cols, _ := rows.Columns()
		for rows.Next() {
			cells := make([]sql.NullString, len(cols))
			ptrs := make([]any, len(cols))
			for i := range cells {
				ptrs[i] = &cells[i]
			}
			if err := rows.Scan(ptrs...); err != nil {
				res.Err = err.Error()
				break
			}
			row := make([]*string, len(cols))
			for i, c := range cells {
				if c.Valid {
					v := c.String
					row[i] = &v
				}
			}
			res.Rows = append(res.Rows, row)
		}
		if err := rows.Err(); err != nil && res.Err == "" {
			res.Err = err.Error()
		}
		rows.Close()
		if q.Required && res.Err != "" {
			return nil, sqlError(res.Err)
		}
		out[q.Name] = res
	}
	return out, nil
}

type sqlError string

func (e sqlError) Error() string { return string(e) }

// cell returns row r, column c of a query's result as text ("" when absent or NULL).
func (r oracleResult) cell(row, col int) string {
	if row >= len(r.Rows) || col >= len(r.Rows[row]) || r.Rows[row][col] == nil {
		return ""
	}
	return strings.TrimSpace(*r.Rows[row][col])
}

func oracleRole(databaseRole string) string {
	switch role := strings.ToUpper(databaseRole); {
	case role == "PRIMARY":
		return "primary"
	case strings.Contains(role, "STANDBY"):
		return "replica"
	case role == "":
		return "standalone"
	default:
		return strings.ToLower(role)
	}
}

// oracleInventory turns the recorded query results into the engine-neutral inventory.
func oracleInventory(res map[string]oracleResult) (*Inventory, error) {
	inst := res["instance"]
	if len(inst.Rows) == 0 {
		return nil, sqlError("v$instance returned no row")
	}
	inv := &Inventory{Engine: EngineOracle, Settings: map[string]any{}}
	instanceName := inst.cell(0, 0)
	inv.Version = firstNonEmpty(res["version_full"].cell(0, 0), inst.cell(0, 2))
	inv.Edition = res["banner"].cell(0, 0)
	inv.UptimeSeconds, _ = strconv.ParseInt(inst.cell(0, 3), 10, 64)
	inv.Settings["instanceName"] = instanceName
	inv.Settings["instanceHost"] = inst.cell(0, 1)
	inv.Settings["instanceStatus"] = inst.cell(0, 4)

	dbRow := res["database"]
	dbName, cdb := instanceName, false
	inv.Role = "standalone"
	if len(dbRow.Rows) > 0 {
		inv.ClusterID = dbRow.cell(0, 0)
		dbName = firstNonEmpty(dbRow.cell(0, 1), instanceName)
		inv.ClusterName = firstNonEmpty(dbRow.cell(0, 2), dbName)
		inv.Role = oracleRole(dbRow.cell(0, 3))
		inv.Settings["databaseRole"] = dbRow.cell(0, 3)
		inv.Settings["openMode"] = dbRow.cell(0, 4)
		inv.Settings["logMode"] = dbRow.cell(0, 5)
		cdb = strings.EqualFold(dbRow.cell(0, 6), oracleYes)
		inv.Settings["cdb"] = cdb
	}
	inv.Connections, _ = strconv.Atoi(res["sessions"].cell(0, 0))
	params := map[string]string{}
	for i := range res["parameters"].Rows {
		params[strings.ToLower(res["parameters"].cell(i, 0))] = res["parameters"].cell(i, 1)
	}
	inv.MaxConn, _ = strconv.Atoi(params["sessions"])
	if p, err := strconv.Atoi(params["processes"]); err == nil {
		inv.Settings["processes"] = p
	}
	if domain := params["db_domain"]; domain != "" {
		inv.Settings["dbDomain"] = domain
	}
	if inv.Role == "replica" {
		inv.ReplicationOf = params["fal_server"]
	}
	charset := res["charset"].cell(0, 0)
	if charset != "" {
		inv.Settings["characterSet"] = charset
	}

	sizes := map[string]int64{}
	for i := range res["datafiles"].Rows {
		n, _ := strconv.ParseInt(res["datafiles"].cell(i, 1), 10, 64)
		sizes[res["datafiles"].cell(i, 0)] = n
	}
	openMode, _ := inv.Settings["openMode"].(string)
	if cdb {
		// A session opened on a PDB service sees only its own container: the root is reported only
		// when its datafiles are visible.
		if _, rootVisible := sizes[oracleRootConID]; rootVisible {
			inv.Databases = append(inv.Databases, Database{Name: dbName, SizeBytes: sizes[oracleRootConID], Encoding: charset, State: strings.ToLower(openMode), Extra: map[string]any{"container": "CDB$ROOT", "conId": oracleRootConNo}})
		}
		pdbs := res["pdbs"]
		for i := range pdbs.Rows {
			name := pdbs.cell(i, 1)
			if name == "" || strings.EqualFold(name, oracleSeedPDB) {
				continue
			}
			conID, _ := strconv.Atoi(pdbs.cell(i, 0))
			size, _ := strconv.ParseInt(pdbs.cell(i, 3), 10, 64)
			if size == 0 {
				size = sizes[pdbs.cell(i, 0)]
			}
			inv.Databases = append(inv.Databases, Database{Name: name, SizeBytes: size, Encoding: charset, State: strings.ToLower(pdbs.cell(i, 2)), Extra: map[string]any{"container": "PDB", "conId": conID}})
		}
	} else if len(dbRow.Rows) > 0 || len(sizes) > 0 {
		var total int64
		for _, n := range sizes {
			total += n
		}
		inv.Databases = append(inv.Databases, Database{Name: dbName, SizeBytes: total, Encoding: charset, State: strings.ToLower(openMode)})
	}
	for i := range res["standby_dests"].Rows {
		if dest := res["standby_dests"].cell(i, 1); dest != "" {
			inv.Replicas = append(inv.Replicas, dest)
		}
	}
	inv.Raw = marshal(res)
	return inv, nil
}
