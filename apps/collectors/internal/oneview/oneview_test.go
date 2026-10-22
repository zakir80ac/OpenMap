// T-062 REQ-DISC-013 — serves OneView-shaped login, enclosure, server-hardware (paged),
// interconnect and profile collections from httptest and checks chassis, blade, host, iLO and
// interconnect emission.
package oneview

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

func server(t *testing.T) *httptest.Server {
	t.Helper()
	var srv *httptest.Server
	srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/rest/login-sessions" {
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["userName"] != "Administrator" || body["password"] != "pw" {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"sessionID": "sess-1"})
			return
		}
		if r.Header.Get(sessionHeader) != "sess-1" || r.Header.Get(apiHeader) == "" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/rest/enclosures":
			_ = json.NewEncoder(w).Encode(map[string]any{"members": []any{map[string]any{"uri": "/rest/enclosures/enc-1", "name": "SYN-RYD-01", "serialNumber": "CN7604ABCD", "enclosureType": "SY12000", "enclosureModel": "Synergy 12000 Frame", "status": "OK", "state": "Configured", "deviceBayCount": 12, "rackName": "R12"}}})
		case "/rest/server-hardware":
			if r.URL.Query().Get("start") == "" {
				_ = json.NewEncoder(w).Encode(map[string]any{"nextPageUri": "/rest/server-hardware?start=1&count=1", "members": []any{map[string]any{"uri": "/rest/server-hardware/sh-1", "name": "SYN-RYD-01, bay 3", "serialNumber": "CZ3240A001", "model": "Synergy 480 Gen10 Plus", "shortModel": "SY 480 Gen10 Plus", "position": 3, "locationUri": "/rest/enclosures/enc-1", "status": "OK", "powerState": "On", "uuid": "31333138-3131-5A43-3332-343041303031", "processorCount": 2, "processorCoreCount": 56, "processorType": "Intel(R) Xeon(R) Platinum 8380", "memoryMb": 1048576, "romVersion": "I46 v2.80", "mpFirmwareVersion": "3.01", "mpModel": "iLO5", "mpHostInfo": map[string]any{"mpHostName": "ilo-cz3240a001.corp.example", "mpIpAddresses": []any{map[string]string{"address": "10.210.1.13", "type": "Static"}}}, "serverProfileUri": "/rest/server-profiles/sp-1",
					"portMap": map[string]any{"deviceSlots": []any{map[string]any{"deviceName": "Synergy 4820C 10/20/25Gb CNA", "physicalPorts": []any{map[string]string{"mac": "94:40:C9:AA:BB:01", "type": "Ethernet"}, map[string]string{"wwn": "10:00:94:40:C9:AA:BB:02", "type": "FibreChannel"}}}}}}}})
			} else {
				_ = json.NewEncoder(w).Encode(map[string]any{"members": []any{map[string]any{"uri": "/rest/server-hardware/sh-2", "name": "DL380-RACK-01", "serialNumber": "CZJ3240RACK", "model": "ProLiant DL380 Gen11", "status": "Warning", "powerState": "On", "locationUri": "", "mpHostInfo": map[string]any{"mpIpAddresses": []any{map[string]string{"address": "10.210.1.50", "type": "DHCP"}}}}}})
			}
		case "/rest/interconnects":
			_ = json.NewEncoder(w).Encode(map[string]any{"members": []any{map[string]any{"uri": "/rest/interconnects/ic-1", "name": "SYN-RYD-01, interconnect 3", "serialNumber": "TWT9240ICM", "model": "Virtual Connect SE 100Gb F32 Module", "status": "OK", "state": "Configured", "firmwareVersion": "6.20", "enclosureUri": "/rest/enclosures/enc-1", "interconnectIP": "10.210.1.100"}}})
		case "/rest/server-profiles":
			_ = json.NewEncoder(w).Encode(map[string]any{"members": []any{map[string]any{"uri": "/rest/server-profiles/sp-1", "name": "esx-ryd-07", "serverHardwareUri": "/rest/server-hardware/sh-1", "status": "OK"}}})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	_ = srv.URL
	return srv
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

func TestLoginWalkEmit(t *testing.T) {
	srv := server(t)
	defer srv.Close()
	c, _ := restjson.New(srv.URL, defaultPort, restjson.Auth{}, restjson.Options{Headers: map[string]string{apiHeader: defaultAPI}})
	session, err := Login(context.Background(), c, "Administrator", "pw", "")
	if err != nil || session != "sess-1" {
		t.Fatalf("login failed: %v %q", err, session)
	}
	c, _ = restjson.New(srv.URL, defaultPort, restjson.Auth{}, restjson.Options{Headers: map[string]string{apiHeader: defaultAPI, sessionHeader: session}})
	inv, err := Walk(context.Background(), c)
	if err != nil {
		t.Fatal(err)
	}
	if len(inv.Servers) != 2 || len(inv.Enclosures) != 1 || len(inv.Interconnects) != 1 {
		t.Fatalf("walk wrong: %+v", inv)
	}
	obs := Emit(inv, contract.Target{Kind: "host", Value: "oneview.corp.example"}, time.Now())
	if count(obs.Cis, typeChassis) != 1 || count(obs.Cis, typeBlade) != 1 || count(obs.Cis, typeHost) != 2 || count(obs.Cis, typeBmc) != 2 || count(obs.Cis, typeSwitch) != 1 {
		t.Fatalf("unexpected CI mix: %+v", obs.Cis)
	}
	for _, ci := range obs.Cis {
		switch {
		case ci.Type == typeBlade:
			if ci.Identity["chassisRef"] != "CN7604ABCD" || ci.Identity["bay"] != "3" || ci.Identity["serialNumber"] != "CZ3240A001" {
				t.Fatalf("blade identity wrong: %+v", ci.Identity)
			}
		case ci.Type == typeHost && ci.Identity["serialNumber"] == "CZ3240A001":
			if ci.Identity["primaryMac"] != "94:40:c9:aa:bb:01" || ci.Attributes["serverProfile"] != "esx-ryd-07" || ci.Attributes["memoryMb"] != int64(1048576) {
				t.Fatalf("host wrong: %+v", ci)
			}
		case ci.Type == typeHost:
			if ci.Attributes["health"] != "degraded" {
				t.Fatalf("rack server health wrong: %+v", ci.Attributes)
			}
		}
	}
	rels := map[string]int{}
	for _, r := range obs.Relationships {
		rels[r.Type]++
	}
	if rels[relContains] != 3 || rels[relManages] != 2 {
		t.Fatalf("relationship mix wrong: %+v", rels)
	}
}

func TestBadLogin(t *testing.T) {
	srv := server(t)
	defer srv.Close()
	c, _ := restjson.New(srv.URL, defaultPort, restjson.Auth{}, restjson.Options{Headers: map[string]string{apiHeader: defaultAPI}})
	if _, err := Login(context.Background(), c, "Administrator", "no", ""); err == nil || !strings.Contains(err.Error(), "unsupported_device") && !strings.Contains(err.Error(), "auth") {
		t.Fatalf("expected a rejection, got %v", err)
	}
}
