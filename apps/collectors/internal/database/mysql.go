// REQ-DISC-024 — MySQL / MariaDB probe: version, server UUID, replication role and source, status
// counters and per-schema sizes from information_schema.
package database

import (
	"context"
	"database/sql"
	"net"
	"strconv"
	"strings"

	mysqldriver "github.com/go-sql-driver/mysql"
)

type mysqlProber struct{}

func (mysqlProber) Probe(ctx context.Context, host string, port int, user, password string, tls bool, dbName string) (*Inventory, error) {
	cfg := mysqldriver.NewConfig()
	cfg.User, cfg.Passwd = user, password
	cfg.Net, cfg.Addr = "tcp", net.JoinHostPort(host, strconv.Itoa(port))
	cfg.DBName = dbName
	cfg.Timeout = connectTimeout
	cfg.ReadTimeout = connectTimeout
	if tls {
		cfg.TLSConfig = "preferred"
	}
	db, err := sql.Open("mysql", cfg.FormatDSN())
	if err != nil {
		return nil, err
	}
	defer db.Close()
	if err := db.PingContext(ctx); err != nil {
		return nil, err
	}
	inv := &Inventory{Engine: EngineMySQL, Settings: map[string]any{}, Role: "standalone"}
	var hostname, serverUUID, versionComment string
	_ = db.QueryRowContext(ctx, "SELECT VERSION()").Scan(&inv.Version)
	_ = db.QueryRowContext(ctx, "SELECT @@hostname").Scan(&hostname)
	_ = db.QueryRowContext(ctx, "SELECT @@version_comment").Scan(&versionComment)
	if err := db.QueryRowContext(ctx, "SELECT @@server_uuid").Scan(&serverUUID); err != nil {
		var serverID string
		_ = db.QueryRowContext(ctx, "SELECT @@server_id").Scan(&serverID) // MariaDB has no server_uuid
		serverUUID = hostname + ":" + serverID
	}
	inv.ClusterID = serverUUID
	inv.ClusterName = hostname
	inv.Edition = versionComment
	for _, name := range []string{"Uptime", "Threads_connected", "Max_used_connections"} {
		var k, v string
		if err := db.QueryRowContext(ctx, "SHOW GLOBAL STATUS LIKE '"+name+"'").Scan(&k, &v); err == nil {
			n, _ := strconv.Atoi(v)
			switch name {
			case "Uptime":
				inv.UptimeSeconds = int64(n)
			case "Threads_connected":
				inv.Connections = n
			}
		}
	}
	var maxConn int
	if err := db.QueryRowContext(ctx, "SELECT @@max_connections").Scan(&maxConn); err == nil {
		inv.MaxConn = maxConn
	}
	for _, s := range []string{"datadir", "log_bin", "gtid_mode", "innodb_buffer_pool_size", "read_only"} {
		var v sql.NullString
		if err := db.QueryRowContext(ctx, "SELECT @@"+s).Scan(&v); err == nil && v.Valid {
			inv.Settings[s] = v.String
		}
	}
	// Replica status: MySQL 8.0.22+ uses REPLICA, older servers and MariaDB use SLAVE.
	for _, stmt := range []string{"SHOW REPLICA STATUS", "SHOW SLAVE STATUS"} {
		rows, err := db.QueryContext(ctx, stmt)
		if err != nil {
			continue
		}
		cols, _ := rows.Columns()
		if rows.Next() {
			vals := make([]sql.NullString, len(cols))
			ptrs := make([]any, len(cols))
			for i := range vals {
				ptrs[i] = &vals[i]
			}
			if err := rows.Scan(ptrs...); err == nil {
				for i, c := range cols {
					if strings.EqualFold(c, "Source_Host") || strings.EqualFold(c, "Master_Host") {
						inv.Role = "replica"
						inv.ReplicationOf = vals[i].String
					}
				}
			}
		}
		rows.Close()
		break
	}
	if inv.Role != "replica" {
		if rows, err := db.QueryContext(ctx, "SELECT host FROM information_schema.processlist WHERE command IN ('Binlog Dump','Binlog Dump GTID')"); err == nil {
			for rows.Next() {
				var h string
				if err := rows.Scan(&h); err == nil {
					inv.Replicas = append(inv.Replicas, h)
					inv.Role = "primary"
				}
			}
			rows.Close()
		}
	}
	rows, err := db.QueryContext(ctx, "SELECT table_schema, COALESCE(SUM(data_length + index_length), 0), COUNT(*) FROM information_schema.tables WHERE table_schema NOT IN ('mysql','information_schema','performance_schema','sys') GROUP BY table_schema ORDER BY table_schema")
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var d Database
		var tables int
		if err := rows.Scan(&d.Name, &d.SizeBytes, &tables); err == nil {
			d.State = "online"
			d.Extra = map[string]any{"tableCount": tables}
			inv.Databases = append(inv.Databases, d)
		}
	}
	rows.Close()
	inv.Raw = marshal(map[string]any{"version": inv.Version, "hostname": hostname, "serverUuid": serverUUID, "role": inv.Role, "settings": inv.Settings, "databases": inv.Databases})
	return inv, nil
}
