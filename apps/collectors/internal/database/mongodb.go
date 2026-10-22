// REQ-DISC-024 — MongoDB probe: build info, replica set identity and role from `hello`, server
// status counters and per-database size on disk.
package database

import (
	"context"
	"net"
	"net/url"
	"strconv"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

type mongoProber struct{}

func (mongoProber) Probe(ctx context.Context, host string, port int, user, password string, tls bool, dbName string) (*Inventory, error) {
	u := url.URL{Scheme: "mongodb", Host: net.JoinHostPort(host, strconv.Itoa(port)), Path: "/"}
	q := url.Values{}
	q.Set("directConnection", "true")
	q.Set("appName", "openmap-discovery")
	q.Set("serverSelectionTimeoutMS", strconv.FormatInt(connectTimeout.Milliseconds(), 10))
	if tls {
		q.Set("tls", "true")
	}
	if user != "" {
		u.User = url.UserPassword(user, password)
		q.Set("authSource", firstNonEmpty(dbName, "admin"))
	}
	u.RawQuery = q.Encode()
	client, err := mongo.Connect(options.Client().ApplyURI(u.String()))
	if err != nil {
		return nil, err
	}
	defer func() { _ = client.Disconnect(context.Background()) }()
	admin := client.Database("admin")
	inv := &Inventory{Engine: EngineMongo, Settings: map[string]any{}, Role: "standalone"}
	var build bson.M
	if err := admin.RunCommand(ctx, bson.D{{Key: "buildInfo", Value: 1}}).Decode(&build); err != nil {
		return nil, err
	}
	inv.Version, _ = build["version"].(string)
	var hello bson.M
	if err := admin.RunCommand(ctx, bson.D{{Key: "hello", Value: 1}}).Decode(&hello); err == nil {
		if set, ok := hello["setName"].(string); ok && set != "" {
			inv.ClusterID = set
			inv.ClusterName = set
			if primary, _ := hello["isWritablePrimary"].(bool); primary {
				inv.Role = "primary"
			} else {
				inv.Role = "replica"
				if p, ok := hello["primary"].(string); ok {
					inv.ReplicationOf = p
				}
			}
			if hosts, ok := hello["hosts"].(bson.A); ok {
				for _, h := range hosts {
					if s, ok := h.(string); ok && s != hello["me"] {
						inv.Replicas = append(inv.Replicas, s)
					}
				}
			}
		}
		if msg, ok := hello["msg"].(string); ok && msg == "isdbgrid" {
			inv.Role = "mongos"
		}
	}
	var status bson.M
	if err := admin.RunCommand(ctx, bson.D{{Key: "serverStatus", Value: 1}}).Decode(&status); err == nil {
		inv.UptimeSeconds = toInt64(status["uptime"])
		if conns, ok := status["connections"].(bson.M); ok {
			inv.Connections = int(toInt64(conns["current"]))
			inv.MaxConn = int(toInt64(conns["available"])) + inv.Connections
		}
		if h, ok := status["host"].(string); ok && inv.ClusterID == "" {
			inv.ClusterID = h
			inv.ClusterName = h
		}
		inv.Settings["storageEngine"] = ""
		if se, ok := status["storageEngine"].(bson.M); ok {
			inv.Settings["storageEngine"] = se["name"]
		}
	}
	var dbs bson.M
	if err := admin.RunCommand(ctx, bson.D{{Key: "listDatabases", Value: 1}}).Decode(&dbs); err == nil {
		if list, ok := dbs["databases"].(bson.A); ok {
			for _, item := range list {
				if m, ok := item.(bson.M); ok {
					name, _ := m["name"].(string)
					if name == "local" || name == "config" {
						continue
					}
					inv.Databases = append(inv.Databases, Database{Name: name, SizeBytes: toInt64(m["sizeOnDisk"]), State: "online"})
				}
			}
		}
	}
	inv.Raw = marshal(map[string]any{"version": inv.Version, "role": inv.Role, "replicaSet": inv.ClusterName, "databases": inv.Databases, "replicas": inv.Replicas})
	return inv, nil
}

func toInt64(v any) int64 {
	switch n := v.(type) {
	case int32:
		return int64(n)
	case int64:
		return n
	case float64:
		return int64(n)
	case int:
		return int64(n)
	default:
		return 0
	}
}
