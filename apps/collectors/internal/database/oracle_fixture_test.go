// T-319 REQ-DISC-024 — recorded Oracle Database fixtures (packages/testing/fixtures/vendor/database/
// oracle-database-*). Each capture holds the TNS conversation between the real database collector
// (go-ora, ADR-040) and Oracle Database Free in the container lab, and the query results the collector
// stored as evidence on that run. The TNS bytes are replayed to the real oracleProber; the recorded
// results go through the same pure oracleInventory the probe uses; both inventories must agree and go
// through the real Emit.
package database

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const oracleFixturePrefix = "oracle-database-"

type oracleExpect struct {
	fixtureExpect
	cdb          bool
	pdbs         map[string]string // PDB name -> open mode (lower case), seed excluded
	characterSet string
	logMode      string
	instanceName string
	maxConn      int
}

// tnsFramer reads one client TNS message. Packets carry a 2-byte length until the session negotiates
// large SDUs, then a 4-byte length; a 2-byte length is never zero, which tells the two apart. A CONNECT
// whose descriptor exceeds 230 bytes is sent header-only with the descriptor in the next packet, and
// counts as one message so the replay does not depend on the length of the client's host name.
type tnsFramer struct{}

const (
	tnsHeaderLen       = 8
	tnsTypeConnect     = 1
	tnsConnectDataLen  = 24
	tnsConnectDataOffs = 26
)

func readTNSPacket(r *bufio.Reader) ([]byte, error) {
	hdr := make([]byte, tnsHeaderLen)
	if _, err := io.ReadFull(r, hdr); err != nil {
		return nil, err
	}
	size := int(binary.BigEndian.Uint16(hdr[0:2]))
	if size == 0 {
		size = int(binary.BigEndian.Uint32(hdr[0:4]))
	}
	pkt := make([]byte, size)
	copy(pkt, hdr)
	if _, err := io.ReadFull(r, pkt[tnsHeaderLen:]); err != nil {
		return nil, err
	}
	return pkt, nil
}

func (tnsFramer) next(r *bufio.Reader) error {
	pkt, err := readTNSPacket(r)
	if err != nil {
		return err
	}
	if pkt[4] == tnsTypeConnect && len(pkt) >= tnsConnectDataOffs+2 {
		dataLen := binary.BigEndian.Uint16(pkt[tnsConnectDataLen:])
		offset := binary.BigEndian.Uint16(pkt[tnsConnectDataOffs:])
		if dataLen > 0 && int(offset) == len(pkt) {
			_, err = readTNSPacket(r)
		}
	}
	return err
}

// One row per recorded Oracle fixture directory; a directory without a row fails the test.
var oracleExpectations = map[string]oracleExpect{
	"oracle-database-free-23.26.3.0.0": {
		fixtureExpect: fixtureExpect{
			engine: EngineOracle, host: "ora-lab", port: portOracle, user: "c##openmap", dbName: "FREE",
			clusterID: "1514744704", clusterName: "FREE", version: "23.26.3.0.0", editionHas: "Oracle AI Database 26ai Free Release 23.26.3.0.0",
			role: "primary", databases: []string{"FREE", "FREEPDB1", "INVENTORY"}, minUptime: 1,
		},
		cdb: true, pdbs: map[string]string{"FREEPDB1": "read write", "INVENTORY": "read write"},
		characterSet: "AL32UTF8", logMode: "NOARCHIVELOG", instanceName: "FREE", maxConn: 322,
	},
	// The same database reached through its PDB service: v$ views show only FREEPDB1, so the CDB root
	// is not reported as a database.
	"oracle-database-free-23.26.3.0.0-pdb-service": {
		fixtureExpect: fixtureExpect{
			engine: EngineOracle, host: "ora-lab", port: portOracle, user: "c##openmap", dbName: "FREEPDB1",
			clusterID: "1514744704", clusterName: "FREE", version: "23.26.3.0.0", editionHas: "Oracle AI Database 26ai Free Release 23.26.3.0.0",
			role: "primary", databases: []string{"FREEPDB1"}, minUptime: 1,
		},
		cdb: true, pdbs: map[string]string{"FREEPDB1": "read write"},
		characterSet: "AL32UTF8", logMode: "NOARCHIVELOG", instanceName: "FREE", maxConn: 322,
	},
}

func loadOracleResults(t *testing.T, dir string) map[string]oracleResult {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, "results.json"))
	if err != nil {
		t.Fatalf("results: %v", err)
	}
	var res map[string]oracleResult
	if err := json.Unmarshal(b, &res); err != nil {
		t.Fatalf("results json: %v", err)
	}
	return res
}

func TestREQDISC024_T319_RecordedOracleFixtures(t *testing.T) {
	entries, err := os.ReadDir(fixtureRoot)
	if err != nil {
		t.Fatalf("read fixtures: %v", err)
	}
	seen := 0
	for _, e := range entries {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), oracleFixturePrefix) {
			continue
		}
		seen++
		name := e.Name()
		dir := filepath.Join(fixtureRoot, name)
		t.Run(name, func(t *testing.T) {
			want, ok := oracleExpectations[name]
			if !ok {
				t.Fatalf("fixture %s has no expectation row", name)
			}
			assertManifest(t, dir)

			// The recorded TNS conversation through the real go-ora prober.
			replayed := inventoryFromFixture(t, dir, want.fixtureExpect)
			// The query results the collector stored as evidence on the same run.
			recorded, err := oracleInventory(loadOracleResults(t, dir))
			if err != nil {
				t.Fatalf("oracle inventory: %v", err)
			}
			replayed.Raw, recorded.Raw = nil, nil
			if !reflect.DeepEqual(replayed, recorded) {
				t.Errorf("replayed inventory differs from the recorded results:\n%+v\n%+v", replayed, recorded)
			}
			inv := recorded
			inv.Raw = marshal(loadOracleResults(t, dir))
			assertInventory(t, inv, want.fixtureExpect)
			if inv.Settings["cdb"] != want.cdb || inv.Settings["characterSet"] != want.characterSet || inv.Settings["logMode"] != want.logMode || inv.Settings["instanceName"] != want.instanceName || inv.MaxConn != want.maxConn {
				t.Errorf("settings %v maxConn %d", inv.Settings, inv.MaxConn)
			}
			pdbs := map[string]string{}
			for _, d := range inv.Databases {
				if d.Encoding != want.characterSet {
					t.Errorf("database %s encoding %q", d.Name, d.Encoding)
				}
				if d.Extra["container"] == "PDB" {
					pdbs[d.Name] = d.State
				} else if d.Extra["container"] != "CDB$ROOT" || d.Extra["conId"] != oracleRootConNo {
					t.Errorf("root container %+v", d)
				}
			}
			if !reflect.DeepEqual(pdbs, want.pdbs) {
				t.Errorf("pdbs %v want %v", pdbs, want.pdbs)
			}
			assertEmit(t, inv, want.fixtureExpect)
		})
	}
	if seen == 0 {
		t.Fatal("no recorded Oracle fixtures found")
	}
}
