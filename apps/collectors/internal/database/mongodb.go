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
	replies, err := runMongoCommands(ctx, client.Database("admin"))
	if err != nil {
		return nil, err
	}
	return mongoInventory(replies)
}

// mongoReplies holds the raw command replies the probe reads; a nil reply means the server refused
// that command (buildInfo is the only one that must succeed).
type mongoReplies struct {
	BuildInfo     bson.Raw
	Hello         bson.Raw
	ServerStatus  bson.Raw
	ListDatabases bson.Raw
}

func runMongoCommands(ctx context.Context, admin *mongo.Database) (mongoReplies, error) {
	var r mongoReplies
	var err error
	if r.BuildInfo, err = admin.RunCommand(ctx, bson.D{{Key: "buildInfo", Value: 1}}).Raw(); err != nil {
		return r, err
	}
	if raw, err := admin.RunCommand(ctx, bson.D{{Key: "hello", Value: 1}}).Raw(); err == nil {
		r.Hello = raw
	}
	if raw, err := admin.RunCommand(ctx, bson.D{{Key: "serverStatus", Value: 1}}).Raw(); err == nil {
		r.ServerStatus = raw
	}
	if raw, err := admin.RunCommand(ctx, bson.D{{Key: "listDatabases", Value: 1}}).Raw(); err == nil {
		r.ListDatabases = raw
	}
	return r, nil
}

// mongoInventory turns the command replies into the engine-neutral inventory.
func mongoInventory(r mongoReplies) (*Inventory, error) {
	inv := &Inventory{Engine: EngineMongo, Settings: map[string]any{}, Role: "standalone"}
	var build bson.M
	if err := bson.Unmarshal(r.BuildInfo, &build); err != nil {
		return nil, err
	}
	inv.Version, _ = build["version"].(string)
	var hello bson.M
	if r.Hello != nil && bson.Unmarshal(r.Hello, &hello) == nil {
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
	if r.ServerStatus != nil && bson.Unmarshal(r.ServerStatus, &status) == nil {
		inv.UptimeSeconds = toInt64(status["uptime"])
		if conns, ok := asDocument(status["connections"]); ok {
			inv.Connections = int(toInt64(conns["current"]))
			inv.MaxConn = int(toInt64(conns["available"])) + inv.Connections
		}
		if h, ok := status["host"].(string); ok && inv.ClusterID == "" {
			inv.ClusterID = h
			inv.ClusterName = h
		}
		inv.Settings["storageEngine"] = ""
		if se, ok := asDocument(status["storageEngine"]); ok {
			inv.Settings["storageEngine"] = se["name"]
		}
	}
	var dbs bson.M
	if r.ListDatabases != nil && bson.Unmarshal(r.ListDatabases, &dbs) == nil {
		if list, ok := dbs["databases"].(bson.A); ok {
			for _, item := range list {
				if m, ok := asDocument(item); ok {
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

// asDocument reads an embedded document whichever way the driver decoded it: driver v2 decodes
// documents nested inside a bson.M as bson.D, so a bson.M type assertion alone never matches.
func asDocument(v any) (bson.M, bool) {
	switch d := v.(type) {
	case bson.M:
		return d, true
	case bson.D:
		m := make(bson.M, len(d))
		for _, e := range d {
			m[e.Key] = e.Value
		}
		return m, true
	default:
		return nil, false
	}
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
