// T-312 REQ-DISC-024 — recorded vendor fixtures for the database collector. Every directory under
// packages/testing/fixtures/vendor/database was captured from a real engine in the container lab
// (see each manifest.json). Wire-protocol captures (PostgreSQL, MySQL/MariaDB, Redis/Valkey, SQL Server)
// are replayed byte-for-byte to the engine's real prober: a replay listener reads each client message
// by protocol framing and answers with the server bytes the engine actually sent. MongoDB command
// replies were recorded as raw BSON documents from the real driver and fed to the same pure
// function the production probe uses. The resulting inventory goes through the real Emit.
package database

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const fixtureRoot = "../../../../packages/testing/fixtures/vendor/database"

type fixtureExpect struct {
	engine        string
	host          string // the lab host name the capture was taken from (target value in Emit)
	port          int    // the engine's real port inside the lab
	user          string
	dbName        string
	clusterID     string
	clusterName   string
	version       string
	editionHas    string
	role          string
	replicationOf string
	databases     []string
	replicaIPs    []string
	minUptime     int64
}

// One row per recorded fixture directory; a directory without a row fails the test.
var fixtureExpectations = map[string]fixtureExpect{
	"postgresql-postgresql-17.11-primary": {
		engine: EnginePostgres, host: "pg-primary", port: portPostgres, user: "openmap",
		clusterID: "7705163688065015848", clusterName: "fxlab-pg", version: "17.11", editionHas: "PostgreSQL 17.11 (Debian",
		role: "primary", databases: []string{"billing", "inventory", "postgres"}, replicaIPs: []string{"192.168.144.6"}, minUptime: 1,
	},
	"postgresql-postgresql-17.11-replica": {
		engine: EnginePostgres, host: "pg-replica", port: portPostgres, user: "openmap",
		clusterID: "7705163688065015848", clusterName: "fxlab-pg-replica", version: "17.11", editionHas: "PostgreSQL 17.11",
		role: "replica", replicationOf: "fxlab-d-pg1", databases: []string{"billing", "inventory", "postgres"}, minUptime: 1,
	},
	"oracle-mysql-8.4.13-primary": {
		engine: EngineMySQL, host: "mysql-primary", port: portMySQL, user: "openmap",
		clusterID: "4acd8156-da24-11f1-b766-8208e1523c56", clusterName: "mysql-primary", version: "8.4.13", editionHas: "MySQL Community Server - GPL",
		role: "primary", databases: []string{"crm", "ledger"}, replicaIPs: []string{"192.168.144.9"}, minUptime: 1,
	},
	"oracle-mysql-8.4.13-replica": {
		engine: EngineMySQL, host: "mysql-replica", port: portMySQL, user: "openmap",
		clusterID: "4b5b7f18-da24-11f1-9218-0a3e7bbeeb87", clusterName: "mysql-replica", version: "8.4.13", editionHas: "MySQL Community Server - GPL",
		role: "replica", replicationOf: "fxlab-d-mysql1", databases: []string{"crm", "ledger"}, minUptime: 1,
	},
	"mariadb-mariadb-11.4": {
		engine: EngineMySQL, host: "mariadb-lab", port: portMySQL, user: "openmap",
		clusterID: "mariadb-lab:1", clusterName: "mariadb-lab", version: "11.4.13-MariaDB-ubu2404", editionHas: "mariadb.org binary distribution",
		role: "standalone", databases: []string{"hr", "shop"}, minUptime: 1,
	},
	"redis-redis-7.4.12-primary": {
		engine: EngineRedis, host: "redis-primary", port: portRedis,
		clusterID: "a1dc331c8040fa689decb78f6331c3b3d7f5f162", clusterName: "redis @ 127.0.0.1", version: "7.4.12", editionHas: "redis",
		role: "primary", databases: []string{"db0", "db3"}, replicaIPs: []string{"192.168.144.7"}, minUptime: 1,
	},
	"redis-redis-7.4.12-replica": {
		engine: EngineRedis, host: "redis-replica", port: portRedis, version: "7.4.12", editionHas: "redis",
		role: "replica", replicationOf: "fxlab-d-redis1:6379", databases: []string{"db0", "db3"}, minUptime: 1,
	},
	"microsoft-sqlserver-2022-16.0.4305.5": {
		engine: EngineMSSQL, host: "mssql-lab", port: portMSSQL, user: "openmap",
		clusterID: "mssql-lab", clusterName: "mssql-lab", version: "16.0.4305.5", editionHas: "Developer Edition (64-bit)",
		role: "standalone", databases: []string{"Inventory", "Payroll"}, minUptime: 1,
	},
	"mongodb-mongodb-8.0.34-primary": {
		engine: EngineMongo, host: "mongo-a", port: portMongo,
		clusterID: "rs-fxlab", clusterName: "rs-fxlab", version: "8.0.34", editionHas: "",
		role: "primary", databases: []string{"admin", "catalog", "telemetry"}, minUptime: 1,
	},
	"mongodb-mongodb-8.0.34-secondary": {
		engine: EngineMongo, host: "mongo-b", port: portMongo,
		clusterID: "rs-fxlab", clusterName: "rs-fxlab", version: "8.0.34", editionHas: "",
		role: "replica", replicationOf: "mongo-a:27017", databases: []string{"admin", "catalog", "telemetry"}, minUptime: 1,
	},
	"valkey-valkey-8.1.10": {
		engine: EngineRedis, host: "valkey-lab", port: portRedis, version: "8.1.10", editionHas: "valkey",
		role: "primary", databases: []string{"db0", "db1"}, minUptime: 1,
	},
}

// TestREQDISC024_T312_RecordedVendorFixtures replays every recorded engine through the real prober and Emit.
func TestREQDISC024_T312_RecordedVendorFixtures(t *testing.T) {
	entries, err := os.ReadDir(fixtureRoot)
	if err != nil {
		t.Fatalf("read fixtures: %v", err)
	}
	seen := 0
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		if strings.HasPrefix(name, oracleFixturePrefix) {
			continue // Oracle recordings run under T-319 (oracle_fixture_test.go)
		}
		seen++
		dir := filepath.Join(fixtureRoot, name)
		t.Run(name, func(t *testing.T) {
			want, ok := fixtureExpectations[name]
			if !ok {
				t.Fatalf("fixture %s has no expectation row", name)
			}
			assertManifest(t, dir)
			inv := inventoryFromFixture(t, dir, want)
			inv.Engine = want.engine
			assertInventory(t, inv, want)
			assertEmit(t, inv, want)
		})
	}
	if seen == 0 {
		t.Fatal("no recorded database fixtures found")
	}
}

func assertManifest(t *testing.T, dir string) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		t.Fatalf("manifest: %v", err)
	}
	var m struct {
		Family     string `json:"family"`
		CapturedBy string `json:"capturedBy"`
		Files      []struct {
			Name string `json:"name"`
		} `json:"files"`
	}
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("manifest json: %v", err)
	}
	if m.Family != "database" || m.CapturedBy == "" || len(m.Files) == 0 {
		t.Fatalf("manifest incomplete: %+v", m)
	}
	for _, f := range m.Files {
		if _, err := os.Stat(filepath.Join(dir, filepath.FromSlash(f.Name))); err != nil {
			t.Fatalf("manifest lists %s: %v", f.Name, err)
		}
	}
}

func inventoryFromFixture(t *testing.T, dir string, want fixtureExpect) *Inventory {
	t.Helper()
	if want.engine == EngineMongo {
		replies := loadMongoReplies(t, dir)
		inv, err := mongoInventory(replies)
		if err != nil {
			t.Fatalf("mongo inventory: %v", err)
		}
		return inv
	}
	addr, errs := startReplay(t, dir, want.engine)
	host, portText, _ := net.SplitHostPort(addr)
	port, _ := strconv.Atoi(portText)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	inv, err := probers[want.engine].Probe(ctx, host, port, want.user, "replayed", false, want.dbName)
	if err != nil {
		t.Fatalf("probe over replay: %v", err)
	}
	select {
	case rerr := <-errs:
		if rerr != nil {
			t.Fatalf("replay: %v", rerr)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("replay did not finish")
	}
	return inv
}

func assertInventory(t *testing.T, inv *Inventory, want fixtureExpect) {
	t.Helper()
	if want.clusterID != "" && inv.ClusterID != want.clusterID {
		t.Errorf("clusterId = %q, want %q", inv.ClusterID, want.clusterID)
	}
	if inv.ClusterID == "" {
		t.Error("clusterId empty")
	}
	if want.clusterName != "" && inv.ClusterName != want.clusterName {
		t.Errorf("clusterName = %q, want %q", inv.ClusterName, want.clusterName)
	}
	if inv.Version != want.version {
		t.Errorf("version = %q, want %q", inv.Version, want.version)
	}
	if !strings.Contains(inv.Edition, want.editionHas) && !strings.Contains(fmt.Sprint(inv.Settings["versionText"]), want.editionHas) {
		t.Errorf("edition %q does not contain %q", inv.Edition, want.editionHas)
	}
	if inv.Role != want.role {
		t.Errorf("role = %q, want %q", inv.Role, want.role)
	}
	if inv.ReplicationOf != want.replicationOf {
		t.Errorf("replicationOf = %q, want %q", inv.ReplicationOf, want.replicationOf)
	}
	if inv.UptimeSeconds < want.minUptime {
		t.Errorf("uptime = %d", inv.UptimeSeconds)
	}
	if inv.MaxConn <= 0 || inv.Connections <= 0 {
		t.Errorf("connections %d / max %d", inv.Connections, inv.MaxConn)
	}
	var names []string
	for _, d := range inv.Databases {
		names = append(names, d.Name)
	}
	sort.Strings(names)
	if strings.Join(names, ",") != strings.Join(want.databases, ",") {
		t.Errorf("databases = %v, want %v", names, want.databases)
	}
	for i, d := range inv.Databases {
		if want.engine == EngineRedis {
			if keys, _ := d.Extra["keys"].(int64); keys <= 0 {
				t.Errorf("keyspace %s keys %v", d.Name, d.Extra["keys"])
			}
			if i > 0 && inv.Databases[i-1].Name > d.Name {
				t.Errorf("keyspaces not ordered: %s before %s", inv.Databases[i-1].Name, d.Name)
			}
			continue
		}
		if d.SizeBytes <= 0 {
			t.Errorf("database %s size %d", d.Name, d.SizeBytes)
		}
	}
}

func assertEmit(t *testing.T, inv *Inventory, want fixtureExpect) {
	t.Helper()
	at := time.Date(2026, 11, 6, 21, 0, 0, 0, time.UTC)
	obs := Emit(inv, contract.Target{Kind: "host", Value: want.host}, want.port, at)
	if len(obs.Evidence) == 0 || len(obs.Evidence[0].Data) == 0 {
		t.Error("no raw evidence")
	}
	counts := map[string]int{}
	for _, c := range obs.Cis {
		counts[c.Type]++
	}
	if counts[typeCluster] != 1 || counts[typeListener] != 1 || counts[typeDatabase] != len(want.databases) || counts[typeIP] != len(want.replicaIPs) {
		t.Fatalf("ci counts = %v", counts)
	}
	cluster := obs.Cis[0]
	if cluster.Type != typeCluster || cluster.Identity["engine"] != want.engine || cluster.Identity["clusterId"] != inv.ClusterID {
		t.Errorf("cluster identity = %v", cluster.Identity)
	}
	if cluster.Attributes["role"] != want.role || cluster.Attributes["version"] != want.version || cluster.Attributes["host"] != want.host {
		t.Errorf("cluster attributes = %v", cluster.Attributes)
	}
	listener := obs.Cis[1]
	if listener.Identity["hostRef"] != want.host || listener.Identity["port"] != strconv.Itoa(want.port) || listener.Identity["protocol"] != "tcp" {
		t.Errorf("listener identity = %v", listener.Identity)
	}
	rels := map[string]int{}
	for _, r := range obs.Relationships {
		rels[r.Type]++
		if r.From.Type != typeCluster || r.From.Identity["clusterId"] != inv.ClusterID {
			t.Errorf("relationship %s from %v", r.Type, r.From)
		}
		switch r.Type {
		case relHostedOn:
			if r.To.Type != typeHost || r.To.Identity["fqdn"] != want.host {
				t.Errorf("hosted_on to %v", r.To)
			}
		case relRunsOn:
			if r.To.Type != typeListener {
				t.Errorf("runs_on to %v", r.To)
			}
		case relContains:
			if r.To.Type != typeDatabase || r.To.Identity["engine"] != want.engine || r.To.Identity["hostRef"] != want.host {
				t.Errorf("contains to %v", r.To)
			}
		case relReplicate:
			found := false
			for _, ip := range want.replicaIPs {
				if r.To.Identity["address"] == ip {
					found = true
				}
			}
			if r.To.Type != typeIP || !found {
				t.Errorf("replicates_to %v", r.To)
			}
		}
	}
	if rels[relHostedOn] != 1 || rels[relRunsOn] != 1 || rels[relContains] != len(want.databases) || rels[relReplicate] != len(want.replicaIPs) {
		t.Errorf("relationship counts = %v", rels)
	}
}

// --- wire replay -------------------------------------------------------------------------------

type wireStep struct {
	Dir    string `json:"dir"`
	Offset int    `json:"offset"`
	Length int    `json:"length"`
}

type wireIndex struct {
	Protocol    string `json:"protocol"`
	Connections []struct {
		File  string     `json:"file"`
		Steps []wireStep `json:"steps"`
	} `json:"connections"`
}

// framer reads exactly one client message of the engine's protocol.
type framer interface {
	next(r *bufio.Reader) error
}

type redisFramer struct{}

func readLine(r *bufio.Reader) (string, error) {
	line, err := r.ReadString('\n')
	if err != nil {
		return "", err
	}
	return strings.TrimRight(line, "\r\n"), nil
}

func (redisFramer) next(r *bufio.Reader) error {
	head, err := readLine(r)
	if err != nil {
		return err
	}
	if !strings.HasPrefix(head, "*") {
		return nil // inline command: the line is the message
	}
	n, err := strconv.Atoi(head[1:])
	if err != nil {
		return err
	}
	for i := 0; i < n; i++ {
		bulk, err := readLine(r)
		if err != nil {
			return err
		}
		size, err := strconv.Atoi(strings.TrimPrefix(bulk, "$"))
		if err != nil {
			return err
		}
		if _, err := io.CopyN(io.Discard, r, int64(size)+2); err != nil {
			return err
		}
	}
	return nil
}

// pgFramer: the first message on a connection has no type byte (startup); every later one does.
type pgFramer struct{ started bool }

func (f *pgFramer) next(r *bufio.Reader) error {
	if f.started {
		if _, err := r.ReadByte(); err != nil {
			return err
		}
	}
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return err
	}
	size := int64(binary.BigEndian.Uint32(hdr[:])) - int64(len(hdr))
	if _, err := io.CopyN(io.Discard, r, size); err != nil {
		return err
	}
	f.started = true
	return nil
}

type mysqlFramer struct{}

func (mysqlFramer) next(r *bufio.Reader) error {
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return err
	}
	size := int64(hdr[0]) | int64(hdr[1])<<8 | int64(hdr[2])<<16
	_, err := io.CopyN(io.Discard, r, size)
	return err
}

// tdsFramer: every TDS packet carries its own length (header included) in bytes 2..3.
type tdsFramer struct{}

func (tdsFramer) next(r *bufio.Reader) error {
	var hdr [8]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return err
	}
	size := int64(binary.BigEndian.Uint16(hdr[2:4])) - int64(len(hdr))
	_, err := io.CopyN(io.Discard, r, size)
	return err
}

func newFramer(engine string) framer {
	switch engine {
	case EnginePostgres:
		return &pgFramer{}
	case EngineMySQL:
		return mysqlFramer{}
	case EngineMSSQL:
		return tdsFramer{}
	case EngineOracle:
		return tnsFramer{}
	default:
		return redisFramer{}
	}
}

type replayStep struct {
	client   bool
	messages int
	data     []byte
}

// planConnection turns a recorded conversation into steps: client steps carry the number of
// protocol messages the recording holds, server steps carry the bytes the engine sent.
func planConnection(engine string, buf []byte, steps []wireStep) ([]replayStep, error) {
	var plan []replayStep
	f := newFramer(engine)
	for _, s := range steps {
		seg := buf[s.Offset : s.Offset+s.Length]
		if s.Dir == "server" {
			plan = append(plan, replayStep{data: seg})
			continue
		}
		r := bufio.NewReader(bytes.NewReader(seg))
		n := 0
		for {
			if _, err := r.Peek(1); err != nil {
				break
			}
			if err := f.next(r); err != nil {
				return nil, fmt.Errorf("client segment at %d does not frame: %w", s.Offset, err)
			}
			n++
		}
		plan = append(plan, replayStep{client: true, messages: n})
	}
	return plan, nil
}

func startReplay(t *testing.T, dir, engine string) (string, <-chan error) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, "wire.json"))
	if err != nil {
		t.Fatalf("wire index: %v", err)
	}
	var idx wireIndex
	if err := json.Unmarshal(b, &idx); err != nil {
		t.Fatalf("wire index json: %v", err)
	}
	var plans [][]replayStep
	for _, c := range idx.Connections {
		buf, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(c.File)))
		if err != nil {
			t.Fatalf("wire capture: %v", err)
		}
		plan, err := planConnection(engine, buf, c.Steps)
		if err != nil {
			t.Fatalf("%s: %v", c.File, err)
		}
		plans = append(plans, plan)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	errs := make(chan error, 1)
	go func() {
		errs <- serveReplay(ln, engine, plans)
	}()
	return ln.Addr().String(), errs
}

func serveReplay(ln net.Listener, engine string, plans [][]replayStep) error {
	for i, plan := range plans {
		conn, err := ln.Accept()
		if err != nil {
			return fmt.Errorf("accept connection %d: %w", i+1, err)
		}
		if err := replayConnection(conn, engine, plan); err != nil {
			_ = conn.Close()
			return fmt.Errorf("connection %d: %w", i+1, err)
		}
		_ = conn.Close()
	}
	return nil
}

func replayConnection(conn net.Conn, engine string, plan []replayStep) error {
	_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
	r := bufio.NewReader(conn)
	f := newFramer(engine)
	for i, s := range plan {
		if !s.client {
			if _, err := conn.Write(s.data); err != nil {
				return err
			}
			continue
		}
		for m := 0; m < s.messages; m++ {
			if err := f.next(r); err != nil {
				if i == len(plan)-1 {
					// Every server answer has been delivered; the client may close (EOF, or a reset on
					// Windows) without sending the trailing goodbye it sent during the recording.
					return nil
				}
				return fmt.Errorf("step %d message %d: %w", i, m, err)
			}
		}
	}
	return nil
}

// --- MongoDB command replies ------------------------------------------------------------------

// loadMongoReplies reads the raw BSON replies the real driver returned for each probe command.
func loadMongoReplies(t *testing.T, dir string) mongoReplies {
	t.Helper()
	read := func(name string, required bool) []byte {
		b, err := os.ReadFile(filepath.Join(dir, "replies", name+".bson"))
		if err != nil {
			if required {
				t.Fatalf("reply %s: %v", name, err)
			}
			return nil
		}
		return b
	}
	return mongoReplies{
		BuildInfo:     read("buildInfo", true),
		Hello:         read("hello", false),
		ServerStatus:  read("serverStatus", false),
		ListDatabases: read("listDatabases", false),
	}
}
