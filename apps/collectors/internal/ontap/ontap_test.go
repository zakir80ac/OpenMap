// T-046 REQ-DISC-014 REQ-DISC-016 — serves ONTAP REST-shaped records (with a _links.next page)
// from httptest and checks array, LUN (NAA), NFS/CIFS share, LIF address and presentation emission.
package ontap

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/restjson"
)

func recordsOf(items ...any) map[string]any {
	return map[string]any{"records": items, "num_records": len(items)}
}

func server(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, p, ok := r.BasicAuth()
		if !ok || u != "admin" || p != "pw" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		path := r.URL.Path
		switch {
		case path == "/api/cluster":
			_ = json.NewEncoder(w).Encode(map[string]any{"name": "NTAP-RYD-01", "uuid": "c1-uuid", "version": map[string]any{"full": "NetApp Release 9.14.1P6", "generation": 9, "major": 14, "minor": 1}})
		case path == "/api/cluster/nodes":
			_ = json.NewEncoder(w).Encode(recordsOf(map[string]any{"name": "ntap-01a", "uuid": "n1", "serial_number": "721234000123", "model": "AFF-A400", "state": "up"}, map[string]any{"name": "ntap-01b", "uuid": "n2", "serial_number": "721234000124", "model": "AFF-A400", "state": "up"}))
		case path == "/api/svm/svms":
			_ = json.NewEncoder(w).Encode(recordsOf(map[string]any{"name": "svm-nas", "uuid": "s1", "state": "running", "nfs": map[string]bool{"enabled": true}, "cifs": map[string]bool{"enabled": true}}, map[string]any{"name": "svm-san", "uuid": "s2", "state": "running", "fcp": map[string]bool{"enabled": true}}))
		case path == "/api/storage/aggregates":
			_ = json.NewEncoder(w).Encode(recordsOf(map[string]any{"name": "aggr1", "uuid": "a1", "state": "online", "node": map[string]string{"name": "ntap-01a"}, "space": map[string]any{"block_storage": map[string]any{"size": 100000000000000, "used": 40000000000000}}}))
		case path == "/api/storage/volumes" && r.URL.Query().Get("page") == "":
			_ = json.NewEncoder(w).Encode(map[string]any{"records": []any{map[string]any{"name": "home", "uuid": "v1", "state": "online", "type": "rw", "svm": map[string]string{"name": "svm-nas"}, "aggregates": []any{map[string]string{"name": "aggr1"}}, "space": map[string]any{"size": 10995116277760, "used": 2000000000000}, "nas": map[string]any{"path": "/home", "security_style": "unix", "export_policy": map[string]string{"name": "default"}}}},
				"_links": map[string]any{"next": map[string]string{"href": "/api/storage/volumes?page=2"}}})
		case path == "/api/storage/volumes":
			_ = json.NewEncoder(w).Encode(recordsOf(map[string]any{"name": "sanvol", "uuid": "v2", "state": "online", "type": "rw", "svm": map[string]string{"name": "svm-san"}, "space": map[string]any{"size": 5000000000000}, "nas": map[string]any{"path": ""}}))
		case path == "/api/storage/luns":
			_ = json.NewEncoder(w).Encode(recordsOf(map[string]any{"name": "/vol/sanvol/lun0", "uuid": "l1", "serial_number": "wOj4Q]FM2WpV", "os_type": "vmware", "enabled": true, "svm": map[string]string{"name": "svm-san"}, "space": map[string]any{"size": 2199023255552, "used": 900000000000}, "status": map[string]any{"state": "online", "mapped": true}, "location": map[string]any{"volume": map[string]string{"name": "sanvol"}}}))
		case path == "/api/protocols/san/lun-maps":
			_ = json.NewEncoder(w).Encode(recordsOf(map[string]any{"lun": map[string]string{"name": "/vol/sanvol/lun0", "uuid": "l1"}, "igroup": map[string]string{"name": "esx-ryd-01", "uuid": "g1"}, "logical_unit_number": 0}))
		case path == "/api/protocols/san/igroups":
			_ = json.NewEncoder(w).Encode(recordsOf(map[string]any{"name": "esx-ryd-01", "uuid": "g1", "os_type": "vmware", "protocol": "fcp", "initiators": []any{map[string]string{"name": "20:00:00:25:b5:aa:00:01"}}}))
		case path == "/api/protocols/cifs/shares":
			_ = json.NewEncoder(w).Encode(recordsOf(map[string]any{"name": "home", "path": "/home", "svm": map[string]string{"name": "svm-nas"}}, map[string]any{"name": "admin$", "path": "/", "svm": map[string]string{"name": "svm-nas"}}))
		case path == "/api/network/ip/interfaces":
			_ = json.NewEncoder(w).Encode(recordsOf(map[string]any{"name": "nas_lif1", "ip": map[string]string{"address": "10.170.1.20", "netmask": "24"}, "svm": map[string]string{"name": "svm-nas"}, "services": []string{"data_nfs", "data_cifs"}, "state": "up"}))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
}

func count(cis []contract.ObservedCi, typ string) int {
	n := 0
	for _, c := range cis {
		if c.Type == typ {
			n++
		}
	}
	return n
}

func TestWalkAndEmit(t *testing.T) {
	srv := server(t)
	defer srv.Close()
	c, _ := restjson.New(srv.URL, defaultPort, restjson.Auth{User: "admin", Pass: "pw"}, restjson.Options{})
	inv, err := Walk(context.Background(), c)
	if err != nil {
		t.Fatal(err)
	}
	if len(inv.Volumes) != 2 || len(inv.Nodes) != 2 || Serial(inv) != "721234000123" {
		t.Fatalf("walk wrong: volumes=%d nodes=%d serial=%s", len(inv.Volumes), len(inv.Nodes), Serial(inv))
	}
	obs := Emit(inv, contract.Target{Kind: "host", Value: "ntap-ryd-01.corp.example"}, time.Now())
	if count(obs.Cis, typeArray) != 1 || count(obs.Cis, typeLun) != 1 || count(obs.Cis, typeShare) != 2 || count(obs.Cis, typeIP) != 1 {
		t.Fatalf("unexpected CI mix: %+v", obs.Cis)
	}
	for _, ci := range obs.Cis {
		switch ci.Type {
		case typeLun:
			if ci.Identity["wwn"] != WWN("wOj4Q]FM2WpV") || !strings.HasPrefix(ci.Identity["wwn"], naaPrefix) || ci.Attributes["mapped"] != true {
				t.Fatalf("lun wrong: %+v", ci)
			}
		case typeShare:
			if ci.Identity["protocol"] == "nfs" && ci.Identity["path"] != "/home" {
				t.Fatalf("nfs share wrong: %+v", ci.Identity)
			}
			if ci.Identity["protocol"] == "smb" && ci.Identity["path"] != `\\svm-nas\home` {
				t.Fatalf("smb share wrong: %+v", ci.Identity)
			}
		case typeArray:
			if ci.Attributes["capacityBytes"] != int64(100000000000000) || ci.Attributes["nodeCount"] != 2 {
				t.Fatalf("array wrong: %+v", ci.Attributes)
			}
		}
	}
	rels := map[string]int{}
	for _, r := range obs.Relationships {
		rels[r.Type]++
		if r.Type == relPresented && (r.To.Identity["fqdn"] != "esx-ryd-01" || r.Attributes["protocol"] != "fcp") {
			t.Fatalf("presentation wrong: %+v", r)
		}
	}
	if rels[relContains] != 3 || rels[relPresented] != 1 || rels[relUsesIP] != 1 {
		t.Fatalf("relationship mix wrong: %+v", rels)
	}
}

func TestBadCredential(t *testing.T) {
	srv := server(t)
	defer srv.Close()
	c, _ := restjson.New(srv.URL, defaultPort, restjson.Auth{User: "admin", Pass: "x"}, restjson.Options{})
	if _, err := Walk(context.Background(), c); err == nil || !strings.Contains(err.Error(), contract.ErrAuthFailed) {
		t.Fatalf("expected auth_failed, got %v", err)
	}
}
