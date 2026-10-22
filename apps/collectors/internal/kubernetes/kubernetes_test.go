// T-035 REQ-DISC-011 — serves API-server-shaped lists from httptest and checks cluster, namespace,
// node, workload, container, service and registry emission with selector-resolved dependencies.
// Real cluster recordings live under packages/testing/fixtures/vendor/kubernetes.
package kubernetes

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

const token = "eyJ-service-account-token"

func documents() map[string]any {
	labels := map[string]string{"app": "api", "tier": "backend"}
	return map[string]any{
		"/version":           map[string]any{"gitVersion": "v1.31.2", "platform": "linux/amd64"},
		"/api/v1/namespaces": map[string]any{"items": []any{ns("kube-system", "11111111-aaaa"), ns("payments", "22222222-bbbb")}},
		"/api/v1/nodes": map[string]any{"items": []any{map[string]any{
			"metadata": map[string]any{"name": "k8s-ryd-w01.corp.example", "uid": "node-1", "labels": map[string]string{"node-role.kubernetes.io/worker": ""}},
			"spec":     map[string]any{"providerID": "vsphere://4235-0001"},
			"status": map[string]any{
				"nodeInfo":   map[string]any{"systemUUID": "42350000-0000-0000-0000-000000000001", "kubeletVersion": "v1.31.2", "osImage": "Ubuntu 24.04.1 LTS", "kernelVersion": "6.8.0-45-generic", "containerRuntimeVersion": "containerd://1.7.22", "architecture": "amd64", "operatingSystem": "linux"},
				"addresses":  []any{map[string]string{"type": "InternalIP", "address": "10.130.1.11"}},
				"capacity":   map[string]string{"cpu": "16", "memory": "65536Mi", "pods": "110"},
				"conditions": []any{map[string]string{"type": "Ready", "status": "True"}},
			},
		}}},
		"/apis/apps/v1/deployments": map[string]any{"items": []any{map[string]any{
			"metadata": map[string]any{"name": "api", "namespace": "payments", "uid": "dep-api", "labels": labels},
			"spec":     map[string]any{"replicas": 3, "template": map[string]any{"metadata": map[string]any{"labels": labels}, "spec": map[string]any{"containers": []any{map[string]string{"name": "api", "image": "ghcr.io/acme/payments-api:2.4.1"}}}}},
			"status":   map[string]any{"readyReplicas": 3, "availableReplicas": 3},
		}}},
		"/apis/apps/v1/statefulsets": map[string]any{"items": []any{}},
		"/apis/apps/v1/daemonsets":   map[string]any{"items": []any{}},
		"/apis/apps/v1/replicasets":  map[string]any{"items": []any{map[string]any{"metadata": map[string]any{"name": "api-7d9f", "namespace": "payments", "uid": "rs-api", "ownerReferences": []any{map[string]string{"kind": "Deployment", "name": "api", "uid": "dep-api"}}}}}},
		"/api/v1/pods": map[string]any{"items": []any{map[string]any{
			"metadata": map[string]any{"name": "api-7d9f-x1", "namespace": "payments", "uid": "pod-1", "labels": labels, "ownerReferences": []any{map[string]string{"kind": "ReplicaSet", "name": "api-7d9f", "uid": "rs-api"}}},
			"spec":     map[string]any{"nodeName": "k8s-ryd-w01.corp.example"},
			"status":   map[string]any{"phase": "Running", "podIP": "10.244.3.17", "containerStatuses": []any{map[string]any{"name": "api", "containerID": "containerd://abc123", "image": "ghcr.io/acme/payments-api:2.4.1", "imageID": "ghcr.io/acme/payments-api@sha256:deadbeef", "ready": true, "restartCount": 1}}},
		}}},
		"/api/v1/services": map[string]any{"items": []any{map[string]any{
			"metadata": map[string]any{"name": "api", "namespace": "payments", "uid": "svc-api"},
			"spec":     map[string]any{"type": "ClusterIP", "clusterIP": "10.96.12.4", "selector": map[string]string{"app": "api"}, "ports": []any{map[string]any{"name": "http", "port": 80, "targetPort": 8080, "protocol": "TCP"}}},
		}}},
		"/apis/networking.k8s.io/v1/ingresses": map[string]any{"items": []any{map[string]any{
			"metadata": map[string]any{"name": "api", "namespace": "payments", "uid": "ing-api"},
			"spec":     map[string]any{"rules": []any{map[string]any{"host": "api.payments.example", "http": map[string]any{"paths": []any{map[string]any{"path": "/", "backend": map[string]any{"service": map[string]string{"name": "api"}}}}}}}},
		}}},
	}
}

func ns(name, uid string) map[string]any {
	return map[string]any{"metadata": map[string]any{"name": name, "uid": uid}, "status": map[string]string{"phase": "Active"}}
}

func server(t *testing.T) *httptest.Server {
	t.Helper()
	docs := documents()
	return httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+token {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		doc, ok := docs[r.URL.Path]
		if !ok {
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
	c, err := restjson.New(srv.URL, defaultPort, restjson.Auth{Bearer: token}, restjson.Options{})
	if err != nil {
		t.Fatal(err)
	}
	inv, err := Walk(context.Background(), c)
	if err != nil {
		t.Fatal(err)
	}
	obs := Emit(inv, contract.Target{Kind: "url", Value: srv.URL}, "ryd-prod", time.Now())
	if count(obs.Cis, typeCluster) != 1 || count(obs.Cis, typeNamespace) != 2 || count(obs.Cis, typeHost) != 1 || count(obs.Cis, typeWorkload) != 1 || count(obs.Cis, typeContainer) != 1 || count(obs.Cis, typeService) != 1 || count(obs.Cis, typeRegistry) != 1 || count(obs.Cis, typeOS) != 1 || count(obs.Cis, typeIP) != 2 {
		t.Fatalf("unexpected CI mix: %+v", obs.Cis)
	}
	if obs.Cis[0].Identity["clusterUid"] != "11111111-aaaa" || obs.Cis[0].Name != "ryd-prod" || obs.Cis[0].Attributes["version"] != "v1.31.2" {
		t.Fatalf("cluster wrong: %+v", obs.Cis[0])
	}
	rels := map[string]int{}
	for _, r := range obs.Relationships {
		rels[r.Type]++
	}
	if rels[relContains] != 4 || rels[relMemberOf] != 2 || rels[relRunsOn] != 1 || rels[relDependsOn] != 1 || rels[relBackedBy] != 1 || rels[relInstalledOn] != 1 || rels[relUsesIP] != 2 {
		t.Fatalf("relationship mix wrong: %+v", rels)
	}
	for _, ci := range obs.Cis {
		if ci.Type == typeService {
			hosts, _ := ci.Attributes["ingressHosts"].([]string)
			if len(hosts) != 1 || hosts[0] != "api.payments.example/" {
				t.Fatalf("ingress hosts not attached: %+v", ci.Attributes)
			}
		}
		if ci.Type == typeRegistry && ci.Identity["url"] != "https://ghcr.io" {
			t.Fatalf("registry wrong: %+v", ci.Identity)
		}
	}
}

func TestRegistryParsing(t *testing.T) {
	cases := map[string]string{"nginx:1.27": defaultRegistry, "library/nginx": defaultRegistry, "ghcr.io/a/b:1": "ghcr.io", "localhost:5000/x": "localhost:5000", "registry.corp.example/team/app@sha256:ab": "registry.corp.example"}
	for in, want := range cases {
		if got := registryOf(in); got != want {
			t.Fatalf("registryOf(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestBadTokenIsAuthFailed(t *testing.T) {
	srv := server(t)
	defer srv.Close()
	c, _ := restjson.New(srv.URL, defaultPort, restjson.Auth{Bearer: "wrong"}, restjson.Options{})
	_, err := Walk(context.Background(), c)
	if err == nil || !strings.Contains(err.Error(), contract.ErrAuthFailed) {
		t.Fatalf("expected auth_failed, got %v", err)
	}
}
