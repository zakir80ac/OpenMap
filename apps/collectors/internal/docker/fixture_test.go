// T-318 REQ-DISC-011 — replays Docker Engine API responses recorded from real engines (the local Docker
// Desktop 4.84 engine running the OpenMap compose stack, read-only, and a fresh docker:dind 29.9 engine
// with a small workload) through the real Collect/Walk/Emit path over a tcp:// endpoint and checks the
// engine host and OS, containers, registries, subnets, addresses and the edges between them.
package docker

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
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

// replay serves one fixture's recorded exchanges keyed by method and request URI.
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

type containerExpect struct {
	image       string
	imageSource string
	state       string
	ports       []string
	mounts      []string
	networks    []string
	ip          string
	registry    string // "" when no backed_by edge is expected
	compose     string
}

type engineExpect struct {
	options      map[string]any
	engine       string
	engineID     string
	version      string
	osName       string
	osFamily     string
	cpus         int
	memoryBytes  int64
	containerd   bool
	volumes      []string
	containers   int
	ips          int
	subnets      []string // cidr
	registries   []string // url
	backedBy     int
	verifiedEdge int
	checks       map[string]containerExpect // by container name
}

var engineFixtures = map[string]engineExpect{
	"docker-engine-29.6.2-desktop": {
		options: map[string]any{optionLabelFilter: "com.docker.compose.project=openmap"},
		engine:  "docker-desktop", engineID: "f4db0232-1965-4bfc-aa92-674815b435ab", version: "29.6.2", osName: "Docker Desktop", osFamily: "linux",
		cpus: 8, memoryBytes: 25201700864, containerd: true,
		volumes:    []string{"openmap_clickhouse-data", "openmap_evidence", "openmap_meili-data", "openmap_memgraph-data", "openmap_node-evidence", "openmap_node-pki", "openmap_postgres-data", "openmap_prom-data", "openmap_scheduler-pki", "openmap_valkey-data"},
		containers: 18, ips: 17, subnets: []string{"192.168.80.0/20"},
		registries: []string{"https://docker.io", "https://ghcr.io", "https://quay.io"},
		// 18 containers, 7 run Compose-built openmap/* images (local); keycloak (quay.io) and llama.cpp (ghcr.io) name their registry.
		backedBy: 11, verifiedEdge: 2,
		checks: map[string]containerExpect{
			"openmap-postgres-1": {image: "postgres:17", imageSource: imageAssumed, state: "running", ports: []string{"0.0.0.0:5432->5432/tcp", "[::]:5432->5432/tcp"},
				mounts:   []string{"bind:/run/desktop/mnt/host/e/OpenMap/deploy/compose/postgres/init->/docker-entrypoint-initdb.d:ro", "volume:openmap_postgres-data->/var/lib/postgresql/data:rw"},
				networks: []string{"openmap_default"}, ip: "192.168.80.16", registry: "https://docker.io", compose: "postgres"},
			"openmap-api-1": {image: "openmap/api:dev", imageSource: imageLocal, state: "running", ports: []string{"0.0.0.0:4000->4000/tcp", "[::]:4000->4000/tcp"},
				mounts:   []string{"volume:4f17b4338000e87d0f629bda6e04b1e5ad159075510ef7c63f48f964f4a74e75->/var/lib/openmap/evidence:rw", "volume:b6e5f1c19b72d96af27757ac8a3cc2d76299bcd75e7a71346366eaff6cfeb4cb->/etc/openmap/pki:rw"},
				networks: []string{"openmap_default"}, ip: "192.168.80.11", compose: "api"},
			"openmap-migrate-1": {image: "openmap/reconciler:dev", imageSource: imageLocal, state: "exited",
				mounts:   []string{"volume:d5d31e8afcaa53524ffd384e8de923827b367301e7277288b90ee1f2869030db->/var/lib/openmap/evidence:rw", "volume:e3a87999ebd9430b126d971e47de4efe0bd925dcb2c3c8f5658d1139e7b69659->/etc/openmap/pki:rw"},
				networks: []string{"openmap_default"}, compose: "migrate"},
			"openmap-keycloak-1": {image: "quay.io/keycloak/keycloak:26.2", imageSource: imageFromRegistry, state: "running", ports: []string{"0.0.0.0:8080->8080/tcp", "[::]:8080->8080/tcp"},
				mounts:   []string{"bind:/run/desktop/mnt/host/e/OpenMap/deploy/compose/keycloak/realm-openmap.json->/opt/keycloak/data/import/realm-openmap.json:ro"},
				networks: []string{"openmap_default"}, ip: "192.168.80.10", registry: "https://quay.io", compose: "keycloak"},
		},
	},
	"docker-engine-29.9.3-dind": {
		options: map[string]any{},
		engine:  "fxlab-i-dind", engineID: "6c93b1f4-0873-45fd-a738-b012a04759e1", version: "29.9.3", osName: "Alpine Linux v3.24 (containerized)", osFamily: "linux",
		cpus: 8, memoryBytes: 25201700864, containerd: true,
		volumes:    []string{"shop-cache"},
		containers: 6, ips: 5, subnets: []string{"10.89.0.0/24", "172.17.0.0/16"},
		registries: []string{"https://docker.io", "https://quay.io"},
		// Every container's image has a repo digest; only the busybox reference names its registry. The
		// locally built shop/tools is indistinguishable from a Docker Hub pull in the containerd store.
		backedBy: 6, verifiedEdge: 1,
		checks: map[string]containerExpect{
			"web":        {image: "nginx:1.29-alpine", imageSource: imageAssumed, state: "running", ports: []string{"0.0.0.0:8080->80/tcp", "[::]:8080->80/tcp"}, networks: []string{"shop"}, ip: "10.89.0.2", registry: "https://docker.io"},
			"cache":      {image: "redis:7.4-alpine", imageSource: imageAssumed, state: "running", ports: []string{"6379/tcp"}, mounts: []string{"volume:shop-cache->/data:rw"}, networks: []string{"shop"}, ip: "10.89.0.3", registry: "https://docker.io"},
			"sidecar":    {image: "quay.io/prometheus/busybox:latest", imageSource: imageFromRegistry, state: "running", networks: []string{"shop"}, ip: "10.89.0.4", registry: "https://quay.io"},
			"batch-once": {image: "alpine:3.20", imageSource: imageAssumed, state: "exited", networks: []string{"bridge"}, registry: "https://docker.io"},
			"tools":      {image: "shop/tools:1.0", imageSource: imageAssumed, state: "running", networks: []string{"shop"}, ip: "10.89.0.5", registry: "https://docker.io"},
		},
	},
}

func strs(v any) []string {
	out, _ := v.([]string)
	return out
}

func equal(a, b []string) bool {
	if len(a) == 0 && len(b) == 0 {
		return true
	}
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestREQDISC011_T318_RecordedDockerEngineFixtures(t *testing.T) {
	entries, err := os.ReadDir(fixtureFamily)
	if err != nil {
		t.Fatal(err)
	}
	seen := 0
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		var m struct {
			Collector string `json:"collector"`
			Req       string `json:"req"`
		}
		mb, err := os.ReadFile(filepath.Join(fixtureFamily, entry.Name(), "manifest.json"))
		if err != nil || json.Unmarshal(mb, &m) != nil {
			t.Fatalf("fixture %s: unreadable manifest", entry.Name())
		}
		if m.Collector != "internal/docker" {
			continue
		}
		seen++
		want, ok := engineFixtures[entry.Name()]
		if !ok {
			t.Fatalf("fixture %s has no expectation row", entry.Name())
		}
		if m.Req != "REQ-DISC-011" {
			t.Fatalf("fixture %s manifest req %q", entry.Name(), m.Req)
		}
		dir := filepath.Join(fixtureFamily, entry.Name())
		t.Run(entry.Name(), func(t *testing.T) {
			srv := replay(t, dir)
			endpoint := "tcp://" + strings.TrimPrefix(srv.URL, "http://")
			obs, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "url", Value: endpoint}, nil, want.options)
			if err != nil {
				t.Fatal(err)
			}
			byType := map[string][]contract.ObservedCi{}
			for _, ci := range obs.Cis {
				byType[ci.Type] = append(byType[ci.Type], ci)
			}
			hosts := byType[typeHost]
			if len(hosts) != 1 {
				t.Fatalf("hosts %+v", hosts)
			}
			h := hosts[0]
			if h.Identity["fqdn"] != want.engine || h.Attributes["dockerEngineId"] != want.engineID || h.Attributes["dockerVersion"] != want.version || h.Attributes["apiVersion"] != clientMaxAPIVersion ||
				h.Attributes["cpuCount"] != want.cpus || h.Attributes["memoryBytes"] != want.memoryBytes || h.Attributes["containerdImageStore"] != want.containerd || h.Attributes["operatingSystem"] != want.osName {
				t.Errorf("engine host %+v %+v", h.Identity, h.Attributes)
			}
			if !equal(strs(h.Attributes["volumes"]), want.volumes) {
				t.Errorf("volumes %v want %v", h.Attributes["volumes"], want.volumes)
			}
			osCis := byType[typeOS]
			if len(osCis) != 1 || osCis[0].Identity["hostRef"] != want.engine || osCis[0].Identity["family"] != want.osFamily || osCis[0].Identity["version"] != want.osName {
				t.Errorf("operating system %+v", osCis)
			}
			if len(byType[typeContainer]) != want.containers || len(byType[typeIP]) != want.ips {
				t.Errorf("containers %d (want %d), ips %d (want %d)", len(byType[typeContainer]), want.containers, len(byType[typeIP]), want.ips)
			}
			vrf := vrfPrefix + want.engineID
			var cidrs []string
			for _, s := range byType[typeSubnet] {
				if s.Identity["vrfRef"] != vrf {
					t.Errorf("subnet vrf %+v", s.Identity)
				}
				cidrs = append(cidrs, s.Identity["cidr"])
			}
			sort.Strings(cidrs)
			if !equal(cidrs, want.subnets) {
				t.Errorf("subnets %v want %v", cidrs, want.subnets)
			}
			var regs []string
			for _, r := range byType[typeRegistry] {
				regs = append(regs, r.Identity["url"])
			}
			sort.Strings(regs)
			if !equal(regs, want.registries) {
				t.Errorf("registries %v want %v", regs, want.registries)
			}

			containerByID := map[string]contract.ObservedCi{}
			byName := map[string]contract.ObservedCi{}
			for _, c := range byType[typeContainer] {
				if !strings.HasPrefix(c.Identity["containerId"], containerIDScheme) {
					t.Errorf("container identity %v", c.Identity)
				}
				for k, v := range c.Attributes {
					if _, nested := v.(map[string]any); nested {
						t.Errorf("container %s attribute %s is a nested object", c.Name, k)
					}
				}
				containerByID[c.Identity["containerId"]] = c
				byName[c.Name] = c
			}
			rels := map[string]int{}
			verified := 0
			registryOf := map[string]string{}
			ipOf := map[string]string{}
			inSubnet := map[string]string{}
			for _, r := range obs.Relationships {
				rels[r.Type]++
				switch r.Type {
				case relRunsOn:
					if r.To.Identity["fqdn"] != want.engine {
						t.Errorf("runs_on %+v", r)
					}
				case relBackedBy:
					registryOf[containerByID[r.From.Identity["containerId"]].Name] = r.To.Identity["url"]
					if r.Attributes["verified"] == true {
						verified++
					}
				case relUsesIP:
					ipOf[containerByID[r.From.Identity["containerId"]].Name] = r.To.Identity["address"]
				case relInSubnet:
					inSubnet[r.From.Identity["address"]] = r.To.Identity["cidr"]
				}
			}
			wantRels := map[string]int{relRunsOn: want.containers, relBackedBy: want.backedBy, relUsesIP: want.ips, relInSubnet: want.ips, relInstalledOn: 1}
			for k, v := range wantRels {
				if rels[k] != v {
					t.Errorf("relationship %s: %d want %d", k, rels[k], v)
				}
			}
			if verified != want.verifiedEdge {
				t.Errorf("verified backed_by edges %d want %d", verified, want.verifiedEdge)
			}
			for name, c := range want.checks {
				got, ok := byName[name]
				if !ok {
					t.Errorf("container %s missing", name)
					continue
				}
				a := got.Attributes
				if a["image"] != c.image || a["imageSource"] != c.imageSource || a["state"] != c.state || !equal(strs(a["ports"]), c.ports) || !equal(strs(a["mounts"]), c.mounts) || !equal(strs(a["networks"]), c.networks) {
					t.Errorf("container %s attributes %+v", name, a)
				}
				if c.compose != "" && (a["composeProject"] != "openmap" || a["composeService"] != c.compose) {
					t.Errorf("container %s compose %v/%v", name, a["composeProject"], a["composeService"])
				}
				if registryOf[name] != c.registry {
					t.Errorf("container %s backed_by %q want %q", name, registryOf[name], c.registry)
				}
				if ipOf[name] != c.ip {
					t.Errorf("container %s uses_ip %q want %q", name, ipOf[name], c.ip)
				}
				if c.ip != "" && inSubnet[c.ip] == "" {
					t.Errorf("address %s of %s is in no subnet", c.ip, name)
				}
				for _, l := range strs(a["labels"]) {
					if secretLabelKey.MatchString(strings.SplitN(l, "=", 2)[0]) {
						t.Errorf("container %s kept a secret-looking label %s", name, l)
					}
				}
			}
			if len(obs.Evidence) != len(evidenceBodies) {
				t.Errorf("evidence %d bodies, want %d", len(obs.Evidence), len(evidenceBodies))
			}
		})
	}
	if seen != len(engineFixtures) {
		t.Fatalf("found %d docker engine fixtures, expected %d", seen, len(engineFixtures))
	}
}

// Every JSON response the walk decodes is kept as evidence (/_ping's plain "OK" is not).
var evidenceBodies = []string{pathVersion, pathInfo, pathContainers, pathImages, pathNetworks, pathVolumes}
