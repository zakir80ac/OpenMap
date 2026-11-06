// T-304 REQ-DISC-017 — replays the S3 exchanges recorded from real object stores (MinIO and Ceph RGW)
// through the real Collect/Walk/Emit path and checks every bucket's
// region, versioning, encryption, object sample and the stores' answer to unsupported sub-resources.
package objectstore

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const fixtureFamily = "../../../../packages/testing/fixtures/vendor/object_storage"

type recordedExchange struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}

// replay serves the recorded exchanges of one fixture directory, keyed by method and request URI.
// Signatures are not re-validated: the recording already holds the store's answer to a signed request.
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
		if !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 ") {
			t.Errorf("request %s is not SigV4 signed", r.URL.RequestURI())
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

type bucketExpect struct {
	versioning, encryption string
	objects                int
	bytes                  int64
	publicBlocked          *bool // nil when the store does not implement publicAccessBlock
}

type storeExpect struct {
	owner, region string
	buckets       map[string]bucketExpect
}

var storeFixtures = map[string]storeExpect{
	"minio-minio-RELEASE.2025-09-07T16-13-09Z": {owner: "minio", region: defaultRegion, buckets: map[string]bucketExpect{
		"app-assets":       {versioning: "Enabled", encryption: "none", objects: 3, bytes: 2078},
		"backups":          {versioning: "Disabled", encryption: "AES256", objects: 1, bytes: 65536},
		"public-downloads": {versioning: "Disabled", encryption: "none", objects: 1, bytes: 15},
	}},
	// RGW answers ?publicAccessBlock with an all-false configuration even when none was set.
	"ceph-rgw-18.2.4-reef": {owner: "Ceph demo user", region: "default", buckets: map[string]bucketExpect{
		"archive":           {versioning: "Disabled", encryption: "AES256", objects: 0, bytes: 0, publicBlocked: &notBlocked},
		"inventory-exports": {versioning: "Enabled", encryption: "none", objects: 2, bytes: 4108, publicBlocked: &notBlocked},
	}},
}

var notBlocked = false

func TestREQDISC017_T304_RecordedVendorFixtures(t *testing.T) {
	entries, err := os.ReadDir(fixtureFamily)
	if err != nil {
		t.Fatal(err)
	}
	seen := 0
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		seen++
		want, ok := storeFixtures[entry.Name()]
		if !ok {
			t.Fatalf("fixture %s has no expectation row", entry.Name())
		}
		dir := filepath.Join(fixtureFamily, entry.Name())
		t.Run(entry.Name(), func(t *testing.T) {
			srv := replay(t, dir)
			cred := &contract.Credential{Type: "api_token", Fields: map[string]string{credAccessKey: "replay-access", credSecretKey: "replay-secret"}}
			obs, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "url", Value: srv.URL}, cred, map[string]any{optionPathStyle: true})
			if err != nil {
				t.Fatal(err)
			}
			if len(obs.Cis) != len(want.buckets) {
				t.Fatalf("%d buckets emitted, recorded %d", len(obs.Cis), len(want.buckets))
			}
			endpoint := strings.TrimPrefix(srv.URL, "http://")
			for _, ci := range obs.Cis {
				b, ok := want.buckets[ci.Name]
				if !ok {
					t.Fatalf("unexpected bucket %s", ci.Name)
				}
				a := ci.Attributes
				if ci.Type != typeBucket || ci.Identity["name"] != ci.Name || ci.Identity["endpoint"] != endpoint {
					t.Fatalf("bucket identity %+v", ci.Identity)
				}
				if a["owner"] != want.owner || a["region"] != want.region || a["versioning"] != b.versioning || a["encryption"] != b.encryption || a["objectsSampled"] != b.objects || a["bytesSampled"] != b.bytes || a["sampleTruncated"] != false {
					t.Fatalf("bucket %s facts %+v", ci.Name, a)
				}
				if classes, _ := a["storageClasses"].(map[string]int); classes["STANDARD"] != b.objects || len(classes) > 1 {
					t.Fatalf("bucket %s storage classes %+v", ci.Name, a["storageClasses"])
				}
				if created, _ := a["createdAt"].(string); !strings.HasPrefix(created, "20") {
					t.Fatalf("bucket %s creation date %v", ci.Name, a["createdAt"])
				}
				blocked, hasBlock := a["publicAccessBlocked"]
				if (b.publicBlocked == nil) == hasBlock || (hasBlock && blocked != *b.publicBlocked) {
					t.Fatalf("bucket %s publicAccessBlocked %v", ci.Name, a["publicAccessBlocked"])
				}
			}
		})
	}
	if seen != len(storeFixtures) {
		t.Fatalf("found %d object storage fixtures, expected %d", seen, len(storeFixtures))
	}
}
