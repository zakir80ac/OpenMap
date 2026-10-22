// T-055 REQ-DISC-009 — serves ovirt-engine-shaped JSON (data centres, clusters, hosts, VMs with
// followed NICs and disks, storage domains) from httptest and checks the emitted CIs and relationships.
package ovirt

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
	docs := map[string]any{
		apiBase:                  map[string]any{"product_info": map[string]any{"name": "Oracle Linux Virtualization Manager", "vendor": "Oracle", "version": map[string]string{"full_version": "4.5.4-1.0.el8"}}},
		apiBase + "/datacenters": map[string]any{"data_center": []any{map[string]any{"id": "dc-1", "name": "RYD", "status": "up"}}},
		apiBase + "/clusters":    map[string]any{"cluster": []any{map[string]any{"id": "cl-1", "name": "OLVM-PROD", "data_center": map[string]string{"id": "dc-1"}, "cpu": map[string]string{"type": "Secure Intel Icelake Server Family"}, "version": map[string]string{"major": "4", "minor": "7"}}}},
		apiBase + "/hosts": map[string]any{"host": []any{map[string]any{"id": "h-1", "name": "olvm-kvm-01", "address": "olvm-kvm-01.corp.example", "status": "up", "cluster": map[string]string{"id": "cl-1"}, "memory": "549755813888",
			"hardware_information": map[string]string{"serial_number": "OL1234ABC", "manufacturer": "Oracle Corporation", "product_name": "ORACLE SERVER X9-2", "uuid": "08000000-0000-0000-0000-00112233AABB"},
			"cpu":                  map[string]any{"name": "Intel(R) Xeon(R) Gold 6338", "topology": map[string]string{"sockets": "2", "cores": "32", "threads": "2"}},
			"os":                   map[string]any{"type": "RHEL", "version": map[string]string{"full_version": "8.10"}}, "version": map[string]string{"full_version": "4.50.4"}, "libvirt_version": map[string]string{"full_version": "10.0.0"}}}},
		apiBase + "/vms": map[string]any{"vm": []any{map[string]any{"id": "VM-1", "name": "erp-db-01", "status": "up", "fqdn": "erp-db-01.corp.example", "host": map[string]string{"id": "h-1"}, "cluster": map[string]string{"id": "cl-1"}, "memory": "68719476736",
			"cpu": map[string]any{"topology": map[string]string{"sockets": "8", "cores": "1", "threads": "1"}}, "os": map[string]string{"type": "rhel_8x64"},
			"guest_operating_system": map[string]any{"distribution": "Oracle Linux Server", "family": "Linux", "version": map[string]string{"full_version": "8.10"}},
			"nics":                   map[string]any{"nic": []any{map[string]any{"name": "nic1", "mac": map[string]string{"address": "56:6F:1A:AA:BB:01"}, "reported_devices": map[string]any{"reported_device": []any{map[string]any{"ips": map[string]any{"ip": []any{map[string]string{"address": "10.160.2.21", "version": "v4"}, map[string]string{"address": "fe80::1", "version": "v6"}}}}}}}}},
			"disk_attachments":       map[string]any{"disk_attachment": []any{map[string]any{"disk": map[string]any{"id": "d-1", "name": "erp-db-01_Disk1", "provisioned_size": "1099511627776", "actual_size": "500000000000", "storage_domains": map[string]any{"storage_domain": []any{map[string]string{"id": "sd-1"}}}}}}}}}},
		apiBase + "/storagedomains": map[string]any{"storage_domain": []any{map[string]any{"id": "sd-1", "name": "PURE-FC-01", "type": "data", "available": "10000000000000", "used": "5000000000000", "committed": "7000000000000", "storage": map[string]string{"type": "fcp"}}, map[string]any{"id": "sd-2", "name": "ISO", "type": "iso", "available": "1", "used": "1", "storage": map[string]string{"type": "nfs", "address": "nas-01.corp.example", "path": "/export/iso"}}}},
	}
	return httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, p, ok := r.BasicAuth()
		if !ok || u != "admin@internal" || p != "pw" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		doc, found := docs[r.URL.Path]
		if !found {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(doc)
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
	c, _ := restjson.New(srv.URL, defaultPort, restjson.Auth{User: "admin@internal", Pass: "pw"}, restjson.Options{})
	inv, err := Walk(context.Background(), c)
	if err != nil {
		t.Fatal(err)
	}
	obs := Emit(inv, contract.Target{Kind: "host", Value: "olvm.corp.example"}, "oracle_vm", time.Now())
	if count(obs.Cis, typeCluster) != 1 || count(obs.Cis, typeHost) != 1 || count(obs.Cis, typeHypervisor) != 1 || count(obs.Cis, typeVM) != 1 || count(obs.Cis, typeOS) != 1 || count(obs.Cis, typeIP) != 1 || count(obs.Cis, typeLun) != 1 || count(obs.Cis, typeNas) != 1 {
		t.Fatalf("unexpected CI mix: %+v", obs.Cis)
	}
	for _, ci := range obs.Cis {
		switch ci.Type {
		case typeVM:
			if ci.Identity["instanceUuid"] != "vm-1" || ci.Identity["hypervisorRef"] != "olvm-kvm-01.corp.example" || ci.Identity["fqdn"] != "erp-db-01.corp.example" || ci.Attributes["cpuCount"] != 8 || ci.Attributes["memoryMb"] != int64(65536) {
				t.Fatalf("vm wrong: %+v", ci)
			}
		case typeHost:
			if ci.Identity["serialNumber"] != "OL1234ABC" || ci.Attributes["cpuCount"] != 128 {
				t.Fatalf("host wrong: %+v", ci)
			}
		case typeNas:
			if ci.Identity["arrayRef"] != "nas-01.corp.example" || ci.Identity["path"] != "/export/iso" {
				t.Fatalf("nas wrong: %+v", ci.Identity)
			}
		case typeCluster:
			if ci.Identity["platform"] != "oracle_vm" || ci.Attributes["engineVersion"] != "4.5.4-1.0.el8" {
				t.Fatalf("cluster wrong: %+v", ci)
			}
		}
	}
	rels := map[string]int{}
	for _, r := range obs.Relationships {
		rels[r.Type]++
	}
	if rels[relHostedOn] != 1 || rels[relMemberOf] != 1 || rels[relRunsOn] != 1 || rels[relMountedOn] != 1 || rels[relInstalledOn] != 1 || rels[relUsesIP] != 1 {
		t.Fatalf("relationship mix wrong: %+v", rels)
	}
}

func TestBadCredential(t *testing.T) {
	srv := server(t)
	defer srv.Close()
	c, _ := restjson.New(srv.URL, defaultPort, restjson.Auth{User: "admin@internal", Pass: "x"}, restjson.Options{})
	if _, err := Walk(context.Background(), c); err == nil || !strings.Contains(err.Error(), contract.ErrAuthFailed) {
		t.Fatalf("expected auth_failed, got %v", err)
	}
}
