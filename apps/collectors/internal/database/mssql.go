// REQ-DISC-024 — SQL Server probe: edition, product version, Always On availability group
// identity and role, instance uptime, connections and per-database state, recovery model and size.
package database

import (
	"context"
	"database/sql"
	"net"
	"net/url"
	"strconv"

	_ "github.com/microsoft/go-mssqldb" // registers the "sqlserver" driver
)

// mssqlMaxUserConnections is SQL Server's documented ceiling for 'user connections' (the value in
// effect when the option is left at its default of 0).
const mssqlMaxUserConnections = 32767

type mssqlProber struct{}

func (mssqlProber) Probe(ctx context.Context, host string, port int, user, password string, tls bool, dbName string) (*Inventory, error) {
	q := url.Values{}
	q.Set("database", firstNonEmpty(dbName, "master"))
	q.Set("app name", "openmap-discovery")
	q.Set("dial timeout", strconv.Itoa(int(connectTimeout.Seconds())))
	if tls {
		q.Set("encrypt", "true")
	} else {
		q.Set("encrypt", "disable")
	}
	u := url.URL{Scheme: "sqlserver", User: url.UserPassword(user, password), Host: net.JoinHostPort(host, strconv.Itoa(port)), RawQuery: q.Encode()}
	db, err := sql.Open("sqlserver", u.String())
	if err != nil {
		return nil, err
	}
	defer db.Close()
	if err := db.PingContext(ctx); err != nil {
		return nil, err
	}
	inv := &Inventory{Engine: EngineMSSQL, Settings: map[string]any{}, Role: "standalone"}
	var serverName, productVersion, edition, versionText sql.NullString
	var hadr sql.NullInt64
	if err := db.QueryRowContext(ctx, "SELECT CONVERT(nvarchar(256), SERVERPROPERTY('ServerName')), CONVERT(nvarchar(64), SERVERPROPERTY('ProductVersion')), CONVERT(nvarchar(128), SERVERPROPERTY('Edition')), CONVERT(nvarchar(max), @@VERSION), CONVERT(int, SERVERPROPERTY('IsHadrEnabled'))").Scan(&serverName, &productVersion, &edition, &versionText, &hadr); err != nil {
		return nil, err
	}
	inv.Version = productVersion.String
	inv.Edition = edition.String
	inv.ClusterName = serverName.String
	inv.ClusterID = serverName.String
	inv.Settings["versionText"] = versionText.String
	var uptime sql.NullInt64
	if err := db.QueryRowContext(ctx, "SELECT DATEDIFF(second, sqlserver_start_time, SYSDATETIME()) FROM sys.dm_os_sys_info").Scan(&uptime); err == nil {
		inv.UptimeSeconds = uptime.Int64
	}
	_ = db.QueryRowContext(ctx, "SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE is_user_process = 1").Scan(&inv.Connections)
	var maxConn sql.NullInt64
	if err := db.QueryRowContext(ctx, "SELECT CONVERT(int, value_in_use) FROM sys.configurations WHERE name = 'user connections'").Scan(&maxConn); err == nil {
		inv.MaxConn = int(maxConn.Int64)
		if inv.MaxConn == 0 {
			// 'user connections' 0 is the default and means "the engine maximum", not "none allowed".
			inv.MaxConn = mssqlMaxUserConnections
		}
	}
	if hadr.Valid && hadr.Int64 == 1 {
		var agID, agName, role sql.NullString
		if err := db.QueryRowContext(ctx, "SELECT TOP 1 CONVERT(nvarchar(64), ag.group_id), ag.name, rs.role_desc FROM sys.availability_groups ag JOIN sys.dm_hadr_availability_replica_states rs ON rs.group_id = ag.group_id AND rs.is_local = 1").Scan(&agID, &agName, &role); err == nil && agID.Valid {
			inv.ClusterID = agID.String
			inv.ClusterName = agName.String
			switch role.String {
			case "PRIMARY":
				inv.Role = "primary"
			case "SECONDARY":
				inv.Role = "replica"
			}
			if rows, err := db.QueryContext(ctx, "SELECT replica_server_name, endpoint_url FROM sys.availability_replicas WHERE group_id = CONVERT(uniqueidentifier, @p1)", agID.String); err == nil {
				for rows.Next() {
					var name, endpoint sql.NullString
					if err := rows.Scan(&name, &endpoint); err == nil && name.String != serverName.String {
						inv.Replicas = append(inv.Replicas, name.String)
					}
				}
				rows.Close()
			}
		}
	}
	rows, err := db.QueryContext(ctx, "SELECT d.name, d.state_desc, d.recovery_model_desc, d.compatibility_level, COALESCE(SUM(CONVERT(bigint, mf.size)) * 8 * 1024, 0) FROM sys.databases d LEFT JOIN sys.master_files mf ON mf.database_id = d.database_id WHERE d.database_id > 4 GROUP BY d.name, d.state_desc, d.recovery_model_desc, d.compatibility_level ORDER BY d.name")
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var d Database
		var recovery sql.NullString
		var compat int
		if err := rows.Scan(&d.Name, &d.State, &recovery, &compat, &d.SizeBytes); err == nil {
			d.Extra = map[string]any{"recoveryModel": recovery.String, "compatibilityLevel": compat}
			inv.Databases = append(inv.Databases, d)
		}
	}
	rows.Close()
	inv.Raw = marshal(map[string]any{"serverName": serverName.String, "version": inv.Version, "edition": inv.Edition, "role": inv.Role, "clusterId": inv.ClusterID, "databases": inv.Databases})
	return inv, nil
}
