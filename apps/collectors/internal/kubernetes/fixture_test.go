// T-302 REQ-DISC-011 — replays API server responses recorded from real clusters (kind v1.34 and k3s
// v1.34) through the real Collect/Walk/Emit path and checks the cluster, namespaces,
// node host and OS, workloads, containers, services, registries and the edges between them.
package kubernetes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const fixtureFamily = "../../../../packages/testing/fixtures/vendor/kubernetes"

type recordedExchange struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}

const replayToken = "replay-token"

// replay serves the recorded exchanges of one fixture directory, keyed by method and request URI.
func replay(t *testing.T, dir string) *httptest.Server {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dir, "exchanges.json"))
	if err != nil {
		t.Fatal(err)
	}
	var list []recordedExchange
	if err := json.Unmarshal(raw, &list); err != nil {
		t.Fatal(err)
	}
	byKey := map[string]recordedExchange{}
	for _, e := range list {
		byKey[e.Method+" "+e.Path] = e
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+replayToken {
			t.Errorf("request %s carries no bearer token", r.URL.RequestURI())
		}
		e, ok := byKey[r.Method+" "+r.URL.RequestURI()]
		if !ok {
			t.Errorf("collector requested %s %s, which the recording does not hold", r.Method, r.URL.RequestURI())
			w.WriteHeader(http.StatusNotFound)
			return
		}
		body, err := os.ReadFile(filepath.Join(dir, e.Body))
		if err != nil {
			t.Error(err)
		}
		for k, v := range e.Headers {
			w.Header().Set(k, v)
		}
		w.WriteHeader(e.Status)
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

type clusterExpect struct {
	clusterName, version, distribution string
	nodeName, osImage, runtime         string
	types                              map[string]int
	rels                               map[string]int
	registries                         []string
	selectorEdges                      map[string]string // service name → workload name
	nodeHasUUID                        bool              // k3s in a container reports no systemUUID
	ingressHosts                       map[string]string // service name → first ingress host+path
	externalEndpoints                  map[string]string // service name → first load-balancer address
}

var clusterFixtures = map[string]clusterExpect{
	"kind-kind-v1.34.0": {
		clusterName: "kind-openmap", version: "v1.34.0", distribution: "kind",
		nodeName: "openmap-control-plane", osImage: "Debian GNU/Linux 12 (bookworm)", runtime: "containerd://2.1.3",
		types:         map[string]int{typeCluster: 1, typeNamespace: 6, typeHost: 1, typeOS: 1, typeWorkload: 16, typeService: 12, typeContainer: 22, typeIP: 22, typeRegistry: 3},
		rels:          map[string]int{relContains: 34, relUsesIP: 22, relRunsOn: 22, relMemberOf: 18, relBackedBy: 16, relDependsOn: 11, relInstalledOn: 1},
		registries:    []string{"registry.k8s.io", "docker.io", "quay.io"},
		selectorEdges: map[string]string{"kube-dns": "coredns", "openmap-api": "openmap-api", "openmap-postgres": "openmap-postgres", "openmap-valkey": "openmap-valkey"},
		nodeHasUUID:   true,
	},
	"k3s-k3s-v1.34.1+k3s1": {
		clusterName: "fxlab-k3s", version: "v1.34.1+k3s1", distribution: "k3s",
		nodeName: "fxlab-k3s-server", osImage: "K3s v1.34.1+k3s1", runtime: "containerd://2.1.4-k3s2",
		types:             map[string]int{typeCluster: 1, typeNamespace: 5, typeHost: 1, typeOS: 1, typeWorkload: 6, typeService: 5, typeContainer: 10, typeIP: 11, typeRegistry: 1},
		rels:              map[string]int{relContains: 16, relUsesIP: 11, relRunsOn: 10, relMemberOf: 9, relBackedBy: 7, relDependsOn: 4, relInstalledOn: 1},
		registries:        []string{"docker.io"},
		selectorEdges:     map[string]string{"kube-dns": "coredns", "traefik": "traefik", "web": "web", "cache": "cache"},
		ingressHosts:      map[string]string{"web": "shop.fxlab.test/"},
		externalEndpoints: map[string]string{"traefik": "10.251.77.40"},
	},
}

func TestREQDISC011_T302_RecordedVendorFixtures(t *testing.T) {
	entries, err := os.ReadDir(fixtureFamily)
	if err != nil {
		t.Fatal(err)
	}
	seen := 0
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		// The family also holds Docker Engine captures (internal/docker, T-318).
		var m struct {
			Collector string `json:"collector"`
		}
		if mb, err := os.ReadFile(filepath.Join(fixtureFamily, entry.Name(), "manifest.json")); err != nil || json.Unmarshal(mb, &m) != nil {
			t.Fatalf("fixture %s: unreadable manifest", entry.Name())
		}
		if m.Collector != "internal/kubernetes" {
			continue
		}
		seen++
		want, ok := clusterFixtures[entry.Name()]
		if !ok {
			t.Fatalf("fixture %s has no expectation row", entry.Name())
		}
		dir := filepath.Join(fixtureFamily, entry.Name())
		t.Run(entry.Name(), func(t *testing.T) {
			srv := replay(t, dir)
			cred := &contract.Credential{Type: credTypeToken, Fields: map[string]string{credFieldToken: replayToken}}
			obs, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "url", Value: srv.URL}, cred, map[string]any{optionName: want.clusterName})
			if err != nil {
				t.Fatal(err)
			}
			types := map[string]int{}
			names := map[string]map[string]string{} // type → uid/identity value → name
			var cluster, node, osCi contract.ObservedCi
			for _, ci := range obs.Cis {
				types[ci.Type]++
				switch ci.Type {
				case typeCluster:
					cluster = ci
				case typeHost:
					node = ci
				case typeOS:
					osCi = ci
				}
				if names[ci.Type] == nil {
					names[ci.Type] = map[string]string{}
				}
				names[ci.Type][ci.Identity["uid"]+ci.Identity["url"]] = ci.Name
			}
			for typ, n := range want.types {
				if types[typ] != n {
					t.Fatalf("%s: %d CIs, recorded cluster holds %d (all: %+v)", typ, types[typ], n, types)
				}
			}
			if cluster.Name != want.clusterName || cluster.Identity["clusterUid"] == "" || cluster.Attributes["version"] != want.version || cluster.Attributes["distribution"] != want.distribution || cluster.Attributes["nodesReady"] != 1 {
				t.Fatalf("cluster %+v %+v", cluster.Identity, cluster.Attributes)
			}
			if node.Name != want.nodeName || (node.Identity["systemUuid"] != "") != want.nodeHasUUID || node.Attributes["containerRuntime"] != want.runtime || node.Attributes["osImage"] != want.osImage {
				t.Fatalf("node %+v %+v", node.Identity, node.Attributes)
			}
			if roles, _ := node.Attributes["roles"].([]string); len(roles) != 1 || roles[0] != "control-plane" {
				t.Fatalf("node roles %v", node.Attributes["roles"])
			}
			hostRef := node.Identity["systemUuid"]
			if hostRef == "" {
				hostRef = node.Name
			}
			if osCi.Name != want.osImage || osCi.Identity["hostRef"] != hostRef || osCi.Identity["family"] != "linux" {
				t.Fatalf("operating system %+v", osCi.Identity)
			}
			for _, reg := range want.registries {
				if _, ok := names[typeRegistry]["https://"+reg]; !ok {
					t.Fatalf("registry %s missing from %v", reg, names[typeRegistry])
				}
			}
			for _, ci := range obs.Cis {
				if ci.Type != typeService {
					continue
				}
				if host, ok := want.ingressHosts[ci.Name]; ok {
					if hosts, _ := ci.Attributes["ingressHosts"].([]string); len(hosts) == 0 || hosts[0] != host {
						t.Fatalf("service %s ingress hosts %v", ci.Name, ci.Attributes["ingressHosts"])
					}
				}
				if ep, ok := want.externalEndpoints[ci.Name]; ok {
					if eps, _ := ci.Attributes["externalEndpoints"].([]string); len(eps) == 0 || eps[0] != ep {
						t.Fatalf("service %s external endpoints %v", ci.Name, ci.Attributes["externalEndpoints"])
					}
				}
			}
			rels := map[string]int{}
			edges := map[string]string{}
			for _, r := range obs.Relationships {
				rels[r.Type]++
				if r.Type == relDependsOn && r.Attributes["via"] == "selector" {
					edges[names[typeService][r.From.Identity["uid"]]] = names[typeWorkload][r.To.Identity["uid"]]
				}
				if r.Type == relRunsOn && r.To.Identity["fqdn"] != want.nodeName {
					t.Fatalf("container runs on %+v", r.To.Identity)
				}
			}
			for typ, n := range want.rels {
				if rels[typ] != n {
					t.Fatalf("%s: %d relationships, expected %d (all: %+v)", typ, rels[typ], n, rels)
				}
			}
			for svc, wl := range want.selectorEdges {
				if edges[svc] != wl {
					t.Fatalf("service %s resolves to %q, expected %s", svc, edges[svc], wl)
				}
			}
		})
	}
	if seen != len(clusterFixtures) {
		t.Fatalf("found %d kubernetes fixtures, expected %d", seen, len(clusterFixtures))
	}
}
