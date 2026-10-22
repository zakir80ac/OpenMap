// T-063 REQ-DISC-013 — serves UCSM XML API responses (aaaLogin, configResolveClass per class) from
// httptest and checks fabric interconnect, chassis, blade, host and CIMC emission.
package ucs

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func server(t *testing.T) *httptest.Server {
	t.Helper()
	classes := map[string]string{
		"topSystem":        `<configResolveClass cookie="c1" response="yes" classId="topSystem"><outConfigs><topSystem dn="sys" name="UCS-RYD-01" address="10.220.0.10" mode="cluster" site="RYD"/></outConfigs></configResolveClass>`,
		"networkElement":   `<configResolveClass cookie="c1" response="yes" classId="networkElement"><outConfigs><networkElement dn="sys/switch-A" id="A" serial="FDO2401ABCD" model="UCS-FI-6454" oobIfIp="10.220.0.11" operability="operable" version="4.2(3e)"/><networkElement dn="sys/switch-B" id="B" serial="FDO2401ABCE" model="UCS-FI-6454" oobIfIp="10.220.0.12" operability="operable" version="4.2(3e)"/></outConfigs></configResolveClass>`,
		"equipmentChassis": `<configResolveClass cookie="c1" response="yes" classId="equipmentChassis"><outConfigs><equipmentChassis dn="sys/chassis-1" id="1" serial="FOX2402CHAS" model="UCSB-5108-AC2" operability="operable" power="ok" vendor="Cisco Systems Inc"/></outConfigs></configResolveClass>`,
		"computeBlade":     `<configResolveClass cookie="c1" response="yes" classId="computeBlade"><outConfigs><computeBlade dn="sys/chassis-1/blade-3" chassisId="1" slotId="3" serial="FCH2403B001" model="UCSB-B200-M6" vendor="Cisco Systems Inc" uuid="1b4e28ba-2fa1-11d2-883f-b9a761bde3fb" numOfCpus="2" numOfCores="64" totalMemory="524288" operPower="on" operability="operable" assignedToDn="org-root/ls-esx-ryd-11"/></outConfigs></configResolveClass>`,
		"computeRackUnit":  `<configResolveClass cookie="c1" response="yes" classId="computeRackUnit"><outConfigs><computeRackUnit dn="sys/rack-unit-1" serverId="1" serial="WZP2404RACK" model="UCSC-C240-M6SX" uuid="2b4e28ba-2fa1-11d2-883f-b9a761bde3fc" numOfCpus="2" numOfCores="56" totalMemory="262144" operPower="on" operability="degraded"/></outConfigs></configResolveClass>`,
		"mgmtIf":           `<configResolveClass cookie="c1" response="yes" classId="mgmtIf"><outConfigs><mgmtIf dn="sys/chassis-1/blade-3/mgmt/if-1" externalIp="10.220.9.13" mac="00:3A:9C:AA:BB:01" subject="blade"/><mgmtIf dn="sys/rack-unit-1/mgmt/if-1" externalIp="10.220.9.50" mac="00:3A:9C:AA:BB:50" subject="rack"/><mgmtIf dn="sys/switch-A/mgmt/if-1" externalIp="10.220.0.11" subject="switch"/></outConfigs></configResolveClass>`,
	}
	return httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		s := string(body)
		w.Header().Set("Content-Type", "application/xml")
		switch {
		case strings.HasPrefix(s, "<aaaLogin"):
			if !strings.Contains(s, `inName="admin"`) || !strings.Contains(s, `inPassword="pw"`) {
				_, _ = w.Write([]byte(`<aaaLogin response="yes" errorCode="551" invocationResult="unidentified-fail" errorDescr="Authentication failed"/>`))
				return
			}
			_, _ = w.Write([]byte(`<aaaLogin response="yes" outCookie="c1" outRefreshPeriod="600" outPriv="admin"/>`))
		case strings.HasPrefix(s, "<aaaLogout"):
			_, _ = w.Write([]byte(`<aaaLogout response="yes" outStatus="success"/>`))
		case strings.HasPrefix(s, "<configResolveClass"):
			if !strings.Contains(s, `cookie="c1"`) {
				_, _ = w.Write([]byte(`<configResolveClass response="yes" errorCode="552" errorDescr="Authorization required"/>`))
				return
			}
			for class, doc := range classes {
				if strings.Contains(s, `classId="`+class+`"`) {
					_, _ = w.Write([]byte(doc))
					return
				}
			}
			_, _ = w.Write([]byte(`<configResolveClass response="yes"><outConfigs/></configResolveClass>`))
		default:
			w.WriteHeader(http.StatusBadRequest)
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

func TestLoginWalkEmit(t *testing.T) {
	srv := server(t)
	defer srv.Close()
	c := NewClient(srv.URL, false)
	if err := c.Login(context.Background(), "admin", "pw"); err != nil {
		t.Fatal(err)
	}
	inv, err := c.Walk(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if inv.System.Name != "UCS-RYD-01" || len(inv.Fabrics) != 2 || len(inv.Chassis) != 1 || len(inv.Blades) != 1 || len(inv.RackUnits) != 1 || len(inv.MgmtIfs) != 3 {
		t.Fatalf("walk wrong: %+v", inv)
	}
	obs := Emit(inv, contract.Target{Kind: "host", Value: "10.220.0.10"}, time.Now())
	if count(obs.Cis, typeSwitch) != 2 || count(obs.Cis, typeChassis) != 1 || count(obs.Cis, typeBlade) != 1 || count(obs.Cis, typeHost) != 2 || count(obs.Cis, typeBmc) != 2 {
		t.Fatalf("unexpected CI mix: %+v", obs.Cis)
	}
	for _, ci := range obs.Cis {
		switch {
		case ci.Type == typeBlade:
			if ci.Identity["chassisRef"] != "FOX2402CHAS" || ci.Identity["bay"] != "3" {
				t.Fatalf("blade identity wrong: %+v", ci.Identity)
			}
		case ci.Type == typeHost && ci.Identity["serialNumber"] == "FCH2403B001":
			if ci.Name != "esx-ryd-11" || ci.Attributes["memoryMb"] != 524288 || ci.Attributes["cpuCores"] != 64 {
				t.Fatalf("blade host wrong: %+v", ci)
			}
		case ci.Type == typeHost:
			if ci.Attributes["health"] != "degraded" {
				t.Fatalf("rack unit health wrong: %+v", ci.Attributes)
			}
		}
	}
	rels := map[string]int{}
	for _, r := range obs.Relationships {
		rels[r.Type]++
	}
	if rels[relContains] != 2 || rels[relManages] != 2 {
		t.Fatalf("relationship mix wrong: %+v", rels)
	}
	c.Logout(context.Background())
}

func TestBadLogin(t *testing.T) {
	srv := server(t)
	defer srv.Close()
	err := NewClient(srv.URL, false).Login(context.Background(), "admin", "nope")
	if err == nil || !strings.Contains(err.Error(), contract.ErrAuthFailed) {
		t.Fatalf("expected auth_failed, got %v", err)
	}
}
