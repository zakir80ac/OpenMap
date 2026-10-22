// T-036 REQ-DISC-008 — serves Prism v3 list responses (paginated) and a v2 storage-container list
// from httptest and checks cluster, host/BMC/hypervisor, VM, subnet/VLAN and container emission.
// Real Prism recordings live under packages/testing/fixtures/vendor/nutanix_ahv.
package nutanix

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

func page(entities ...any) map[string]any {
	return map[string]any{"entities": entities, "metadata": map[string]any{"total_matches": len(entities), "length": len(entities), "offset": 0}}
}

func server(t *testing.T) *httptest.Server {
	t.Helper()
	lists := map[string]any{
		"cluster": page(map[string]any{"metadata": map[string]any{"uuid": "cl-1", "kind": "cluster"}, "status": map[string]any{"name": "RYD-NTNX-01", "resources": map[string]any{
			"config":  map[string]any{"software_map": map[string]any{"NOS": map[string]any{"version": "6.10.1"}}, "service_list": []string{"AOS"}},
			"network": map[string]any{"external_ip": "10.140.0.10"},
			"nodes":   map[string]any{"hypervisor_server_list": []any{map[string]any{"ip": "10.140.0.11", "version": "Nutanix 20230302.101026", "type": "AHV"}}},
		}}}),
		"host": page(map[string]any{"metadata": map[string]any{"uuid": "h-1", "kind": "host"}, "status": map[string]any{"name": "ntnx-ryd-a1", "cluster_reference": map[string]any{"kind": "cluster", "uuid": "cl-1"}, "resources": map[string]any{
			"serial_number": "NX7K2M93", "block": map[string]any{"block_model": "NX-3060-G9", "block_serial_number": "23SM1234"},
			"hypervisor": map[string]any{"ip": "10.140.0.11", "hypervisor_full_name": "Nutanix 20230302.101026"}, "controller_vm": map[string]any{"ip": "10.140.0.21"}, "ipmi": map[string]any{"ip": "10.140.9.11"},
			"num_cpu_cores": 64, "num_cpu_sockets": 2, "memory_capacity_mib": 786432, "cpu_model": "Intel(R) Xeon(R) Gold 6448Y", "host_type": "HYPER_CONVERGED",
		}}}),
		"vm": page(map[string]any{"metadata": map[string]any{"uuid": "VM-ABC-1", "kind": "vm"}, "status": map[string]any{"name": "ora-ryd-01", "cluster_reference": map[string]any{"uuid": "cl-1"}, "resources": map[string]any{
			"power_state": "ON", "num_sockets": 4, "num_vcpus_per_socket": 2, "memory_size_mib": 131072, "host_reference": map[string]any{"kind": "host", "uuid": "h-1"},
			"nic_list":    []any{map[string]any{"mac_address": "50:6B:8D:AA:00:01", "ip_endpoint_list": []any{map[string]any{"ip": "10.141.5.21"}}, "subnet_reference": map[string]any{"kind": "subnet", "uuid": "sn-1", "name": "VLAN-141-DB"}}},
			"disk_list":   []any{map[string]any{"disk_size_bytes": 1099511627776, "storage_config": map[string]any{"storage_container_reference": map[string]any{"uuid": "sc-1", "name": "default-container"}}, "device_properties": map[string]any{"device_type": "DISK"}}, map[string]any{"disk_size_bytes": 0, "device_properties": map[string]any{"device_type": "CDROM"}}},
			"guest_tools": map[string]any{"nutanix_guest_tools": map[string]any{"guest_os_version": "Oracle Linux Server 9.4", "state": "ENABLED"}},
		}}}),
		"subnet": page(map[string]any{"metadata": map[string]any{"uuid": "sn-1", "kind": "subnet"}, "status": map[string]any{"name": "VLAN-141-DB", "cluster_reference": map[string]any{"uuid": "cl-1"}, "resources": map[string]any{
			"subnet_type": "VLAN", "vlan_id": 141, "ip_config": map[string]any{"subnet_ip": "10.141.5.0", "prefix_length": 24, "default_gateway_ip": "10.141.5.1"},
		}}}),
	}
	return httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, p, ok := r.BasicAuth()
		if !ok || u != "admin" || p != "secret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == v2Containers {
			_ = json.NewEncoder(w).Encode(map[string]any{"entities": []any{map[string]any{"storage_container_uuid": "sc-1", "cluster_uuid": "cl-1", "name": "default-container", "max_capacity": 54975581388800, "usage_stats": map[string]string{"storage.usage_bytes": "21990232555520"}, "replication_factor": 2, "compression_enabled": true}}})
			return
		}
		if strings.HasPrefix(r.URL.Path, v3) && strings.HasSuffix(r.URL.Path, "s/list") && r.Method == http.MethodPost {
			var body struct {
				Kind string `json:"kind"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if doc, ok := lists[body.Kind]; ok {
				_ = json.NewEncoder(w).Encode(doc)
				return
			}
		}
		w.WriteHeader(http.StatusNotFound)
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
	c, err := restjson.New(srv.URL, defaultPort, restjson.Auth{User: "admin", Pass: "secret"}, restjson.Options{})
	if err != nil {
		t.Fatal(err)
	}
	inv, err := Walk(context.Background(), c)
	if err != nil {
		t.Fatal(err)
	}
	obs := Emit(inv, contract.Target{Kind: "host", Value: "prism.corp.example"}, time.Now())
	if count(obs.Cis, typeCluster) != 1 || count(obs.Cis, typeHost) != 1 || count(obs.Cis, typeBmc) != 1 || count(obs.Cis, typeHypervisor) != 1 || count(obs.Cis, typeVM) != 1 || count(obs.Cis, typeOS) != 1 || count(obs.Cis, typeIP) != 1 || count(obs.Cis, typeSubnet) != 1 || count(obs.Cis, typeVlan) != 1 || count(obs.Cis, typeLun) != 1 {
		t.Fatalf("unexpected CI mix: %+v", obs.Cis)
	}
	for _, ci := range obs.Cis {
		switch ci.Type {
		case typeVM:
			if ci.Identity["instanceUuid"] != "vm-abc-1" || ci.Identity["hypervisorRef"] != "ntnx-ryd-a1" || ci.Attributes["cpuCount"] != 8 || ci.Attributes["diskBytes"] != int64(1099511627776) {
				t.Fatalf("vm wrong: %+v", ci)
			}
		case typeHost:
			if ci.Identity["serialNumber"] != "NX7K2M93" || ci.Attributes["model"] != "NX-3060-G9" {
				t.Fatalf("host wrong: %+v", ci)
			}
		case typeCluster:
			if ci.Attributes["aosVersion"] != "6.10.1" {
				t.Fatalf("cluster wrong: %+v", ci)
			}
		case typeLun:
			if ci.Attributes["usedBytes"] != int64(21990232555520) {
				t.Fatalf("container wrong: %+v", ci)
			}
		}
	}
	rels := map[string]int{}
	for _, r := range obs.Relationships {
		rels[r.Type]++
	}
	if rels[relManages] != 1 || rels[relHostedOn] != 1 || rels[relMemberOf] != 1 || rels[relRunsOn] != 1 || rels[relMountedOn] != 1 || rels[relInstalledOn] != 1 || rels[relUsesIP] != 1 || rels[relInSubnet] != 1 || rels[relInVlan] != 1 {
		t.Fatalf("relationship mix wrong: %+v", rels)
	}
}

func TestBadCredential(t *testing.T) {
	srv := server(t)
	defer srv.Close()
	c, _ := restjson.New(srv.URL, defaultPort, restjson.Auth{User: "admin", Pass: "nope"}, restjson.Options{})
	_, err := Walk(context.Background(), c)
	if err == nil || !strings.Contains(err.Error(), contract.ErrAuthFailed) {
		t.Fatalf("expected auth_failed, got %v", err)
	}
}
