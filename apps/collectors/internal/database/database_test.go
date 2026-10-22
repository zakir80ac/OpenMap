// T-053 REQ-DISC-024 — emission from an engine-neutral inventory, Redis INFO parsing, and live
// probes against the local compose Postgres and Valkey when they answer (skipped otherwise).
package database

import (
	"context"
	"net"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func TestEmit(t *testing.T) {
	inv := &Inventory{Engine: EnginePostgres, Version: "17.2", ClusterID: "7312345678901234567", ClusterName: "pg-core", Role: "primary", UptimeSeconds: 86400, Connections: 12, MaxConn: 200,
		Databases: []Database{{Name: "ledger", SizeBytes: 1 << 30, Owner: "app", Encoding: "UTF8", State: "online"}, {Name: "postgres", SizeBytes: 1 << 20, State: "online"}},
		Replicas:  []string{"10.120.5.41", "replica.corp.example"}, Settings: map[string]any{"wal_level": "replica"}}
	obs := Emit(inv, contract.Target{Kind: "host", Value: "db-ryd-pg-core-01.corp.example"}, 5432, time.Now())
	types := map[string]int{}
	for _, c := range obs.Cis {
		types[c.Type]++
	}
	if types[typeCluster] != 1 || types[typeDatabase] != 2 || types[typeListener] != 1 || types[typeIP] != 1 {
		t.Fatalf("unexpected CI mix: %+v", types)
	}
	cluster := obs.Cis[0]
	if cluster.Identity["engine"] != EnginePostgres || cluster.Identity["clusterId"] != "7312345678901234567" || cluster.Attributes["totalSizeBytes"] != int64(1<<30+1<<20) {
		t.Fatalf("cluster wrong: %+v", cluster)
	}
	rels := map[string]int{}
	for _, r := range obs.Relationships {
		rels[r.Type]++
	}
	if rels[relHostedOn] != 1 || rels[relRunsOn] != 1 || rels[relContains] != 2 || rels[relReplicate] != 1 {
		t.Fatalf("relationship mix wrong: %+v", rels)
	}
	for _, ci := range obs.Cis {
		if ci.Type == typeDatabase && ci.Identity["name"] == "ledger" && (ci.Identity["hostRef"] != "db-ryd-pg-core-01.corp.example" || ci.Identity["port"] != "5432") {
			t.Fatalf("database identity wrong: %+v", ci.Identity)
		}
	}
}

func TestParseRedisInfo(t *testing.T) {
	info := ParseRedisInfo("# Server\r\nredis_version:7.2.4\r\nrun_id:abc\r\n# Replication\r\nrole:master\r\nconnected_slaves:1\r\nslave0:ip=10.0.0.2,port=6379,state=online\r\n# Keyspace\r\ndb0:keys=42,expires=1\r\n")
	if info["redis_version"] != "7.2.4" || info["role"] != "master" || info["db0"] != "keys=42,expires=1" {
		t.Fatalf("parse wrong: %+v", info)
	}
}

func reachable(addr string) bool {
	c, err := net.DialTimeout("tcp", addr, time.Second)
	if err != nil {
		return false
	}
	_ = c.Close()
	return true
}

func TestLivePostgres(t *testing.T) {
	if !reachable("127.0.0.1:5432") {
		t.Skip("no local Postgres")
	}
	inv, err := postgresProber{}.Probe(context.Background(), "127.0.0.1", 5432, "openmap", "openmap", false, "openmap")
	if err != nil {
		t.Skipf("local Postgres refused the dev credential: %v", err)
	}
	if inv.Version == "" || inv.ClusterID == "" || inv.Role == "" || len(inv.Databases) == 0 {
		t.Fatalf("postgres probe incomplete: %+v", inv)
	}
	obs := Emit(inv, contract.Target{Kind: "host", Value: "127.0.0.1"}, 5432, time.Now())
	if len(obs.Cis) < 3 {
		t.Fatalf("expected cluster, listener and databases, got %d CIs", len(obs.Cis))
	}
}

func TestLiveRedis(t *testing.T) {
	if !reachable("127.0.0.1:6379") {
		t.Skip("no local Redis/Valkey")
	}
	inv, err := redisProber{}.Probe(context.Background(), "127.0.0.1", 6379, "", "", false, "")
	if err != nil {
		t.Skipf("local Redis refused: %v", err)
	}
	if inv.Version == "" || inv.ClusterID == "" || inv.Role == "" {
		t.Fatalf("redis probe incomplete: %+v", inv)
	}
}
