// REQ-DISC-024 — PostgreSQL probe: version, system identifier (cluster identity), recovery role,
// replication peers, connection counts and per-database sizes from the catalog.
package database

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
)

type postgresProber struct{}

func (postgresProber) Probe(ctx context.Context, host string, port int, user, password string, tls bool, dbName string) (*Inventory, error) {
	sslmode := "disable"
	if tls {
		sslmode = "require"
	}
	u := url.URL{Scheme: "postgres", User: url.UserPassword(user, password), Host: net.JoinHostPort(host, strconv.Itoa(port)), Path: "/" + firstNonEmpty(dbName, "postgres"), RawQuery: "sslmode=" + sslmode + "&connect_timeout=10&application_name=openmap-discovery"}
	conn, err := pgx.Connect(ctx, u.String())
	if err != nil {
		return nil, err
	}
	defer conn.Close(ctx)
	inv := &Inventory{Engine: EnginePostgres, Settings: map[string]any{}}
	var versionText string
	if err := conn.QueryRow(ctx, "SELECT version()").Scan(&versionText); err != nil {
		return nil, err
	}
	inv.Version = pgVersion(versionText)
	inv.Edition = versionText
	var sysID int64
	if err := conn.QueryRow(ctx, "SELECT system_identifier FROM pg_control_system()").Scan(&sysID); err == nil {
		inv.ClusterID = strconv.FormatInt(sysID, 10)
	}
	var inRecovery bool
	if err := conn.QueryRow(ctx, "SELECT pg_is_in_recovery()").Scan(&inRecovery); err == nil {
		inv.Role = "primary"
		if inRecovery {
			inv.Role = "replica"
		}
	}
	var uptime float64
	if err := conn.QueryRow(ctx, "SELECT EXTRACT(EPOCH FROM now() - pg_postmaster_start_time())").Scan(&uptime); err == nil {
		inv.UptimeSeconds = int64(uptime)
	}
	_ = conn.QueryRow(ctx, "SELECT count(*) FROM pg_stat_activity").Scan(&inv.Connections)
	var maxConn string
	if err := conn.QueryRow(ctx, "SHOW max_connections").Scan(&maxConn); err == nil {
		inv.MaxConn, _ = strconv.Atoi(maxConn)
	}
	for _, s := range []string{"data_directory", "wal_level", "archive_mode", "shared_buffers", "listen_addresses", "ssl", "cluster_name"} {
		var v string
		if err := conn.QueryRow(ctx, "SHOW "+s).Scan(&v); err == nil {
			inv.Settings[s] = v
		}
	}
	if name, ok := inv.Settings["cluster_name"].(string); ok && name != "" {
		inv.ClusterName = name
	}
	rows, err := conn.Query(ctx, "SELECT datname, pg_database_size(datname), pg_get_userbyid(datdba), pg_encoding_to_char(encoding) FROM pg_database WHERE NOT datistemplate ORDER BY datname")
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var d Database
		if err := rows.Scan(&d.Name, &d.SizeBytes, &d.Owner, &d.Encoding); err == nil {
			d.State = "online"
			inv.Databases = append(inv.Databases, d)
		}
	}
	rows.Close()
	if inv.Role == "primary" {
		if repl, err := conn.Query(ctx, "SELECT client_addr::text, state, sync_state FROM pg_stat_replication"); err == nil {
			for repl.Next() {
				var addr, state, sync *string
				if err := repl.Scan(&addr, &state, &sync); err == nil && addr != nil {
					// client_addr is inet; its text form carries the mask ("10.0.0.2/32").
					host, _, _ := strings.Cut(*addr, "/")
					inv.Replicas = append(inv.Replicas, host)
				}
			}
			repl.Close()
		}
	} else if inv.Role == "replica" {
		var sender *string
		if err := conn.QueryRow(ctx, "SELECT sender_host FROM pg_stat_wal_receiver").Scan(&sender); err == nil && sender != nil {
			inv.ReplicationOf = *sender
		}
	}
	inv.Raw = marshal(map[string]any{"version": versionText, "systemIdentifier": inv.ClusterID, "role": inv.Role, "settings": inv.Settings, "databases": inv.Databases, "replicas": inv.Replicas})
	return inv, nil
}

// pgVersion extracts "17.2" from "PostgreSQL 17.2 (Debian 17.2-1.pgdg120+1) on x86_64...".
func pgVersion(text string) string {
	f := strings.Fields(text)
	if len(f) >= 2 && strings.EqualFold(f[0], "PostgreSQL") {
		return f[1]
	}
	return text
}

var _ = fmt.Sprint
