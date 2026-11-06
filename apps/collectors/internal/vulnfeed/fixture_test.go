// T-320 REQ-DISC-027 — recorded NVD CVE API 2.0 responses (packages/testing/fixtures/vendor/
// vulnerability_feed/nist-nvd-cve-api-2.0): the response to Fetch's own lastMod window query is
// replayed from httptest at the exact path and query Fetch requests; the cveId pages for
// CVE-2014-0160 and CVE-2024-3094 are decoded with the collector's page type (as restjson does) and
// run through Emit: CVSS selection (NVD Primary over CNA Secondary), KEV, CPE products, CWE, severity floor.
package vulnfeed

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/restjson"
)

const (
	nvdFixtureDir = "../../../../packages/testing/fixtures/vendor/vulnerability_feed/nist-nvd-cve-api-2.0"
	nvdBasePath   = "/rest/json/cves/2.0"
	// The recorded window query (request 1 in the manifest), byte for byte as Fetch encodes it.
	nvdWindowQuery = "lastModEndDate=2026-11-01T03%3A02%3A00.000&lastModStartDate=2026-11-01T03%3A00%3A00.000&resultsPerPage=2000&startIndex=0"
	nvdWindow      = 2 * time.Minute
)

var nvdWindowEnd = time.Date(2026, 11, 1, 3, 2, 0, 0, time.UTC)

type nvdExpect struct {
	severity, version, vector, cvssSource, status, published string
	score, exploitability, impact                            float64
	kev, exploit                                             bool
	kevAdded, kevDue, kevName                                string
	cpeMatches, products, references                         int
	someCpe, someProduct                                     string
	cwe                                                      []string
}

var nvdExpectations = map[string]nvdExpect{
	"CVE-2014-0160": {
		severity: "HIGH", version: "3.1", vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N", cvssSource: "nvd@nist.gov", status: "Analyzed", published: "2014-04-07T22:55:03.893",
		score: 7.5, exploitability: 3.9, impact: 3.6, kev: true, exploit: true,
		kevAdded: "2022-05-04", kevDue: "2022-05-25", kevName: "OpenSSL Information Disclosure Vulnerability",
		cpeMatches: 47, products: 28, references: 257,
		someCpe: "cpe:2.3:a:openssl:openssl:*:*:*:*:*:*:*:* versionStartIncluding=1.0.1 versionEndExcluding=1.0.1g", someProduct: "openssl:openssl",
		cwe: []string{"CWE-125"},
	},
	"CVE-2024-3094": {
		severity: "CRITICAL", version: "3.1", vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H", cvssSource: "nvd@nist.gov", status: "Modified", published: "2024-03-29T17:15:21.150",
		score: 10.0, exploitability: 3.9, impact: 6.0, kev: false, exploit: false,
		cpeMatches: 2, products: 1, references: 59,
		someCpe: "cpe:2.3:a:tukaani:xz:5.6.1:*:*:*:*:*:*:*", someProduct: "tukaani:xz",
		cwe: []string{"CWE-506"},
	},
}

func readNVD(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(nvdFixtureDir, name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// scalarAttributes enforces the contract's attribute rule: JSON scalars or arrays of scalars.
func scalarAttributes(t *testing.T, attrs map[string]any) {
	t.Helper()
	for k, v := range attrs {
		switch v.(type) {
		case string, bool, float64, int, int64, nil, []string, []float64, []bool:
		default:
			t.Errorf("attribute %s has non-scalar type %T", k, v)
		}
	}
}

func TestREQDISC027_T320_RecordedNVDFixtures(t *testing.T) {
	t.Run("window query replayed through Fetch", func(t *testing.T) {
		body := readNVD(t, "window.json")
		calls := 0
		srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls++
			if r.URL.Path != nvdBasePath || r.URL.RawQuery != nvdWindowQuery {
				t.Errorf("Fetch requested %s?%s, the capture answered %s?%s", r.URL.Path, r.URL.RawQuery, nvdBasePath, nvdWindowQuery)
				w.WriteHeader(http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(body)
		}))
		defer srv.Close()
		c, err := restjson.New(srv.URL, defaultPort, restjson.Auth{}, restjson.Options{})
		if err != nil {
			t.Fatal(err)
		}
		items, raw, err := Fetch(context.Background(), c, nvdBasePath, nvdWindow, nvdWindowEnd)
		if err != nil {
			t.Fatal(err)
		}
		if calls != 1 || len(items) != 0 || len(raw) != 1 || string(raw[0]) != string(body) {
			t.Fatalf("empty window: calls=%d items=%d raw=%d", calls, len(items), len(raw))
		}
		obs := Emit(items, raw, "", nvdWindowEnd)
		if len(obs.Cis) != 0 || len(obs.Evidence) != 1 || obs.Evidence[0].Kind != evidenceKind {
			t.Fatalf("empty window emit: %+v", obs)
		}
	})

	at := time.Date(2026, 11, 6, 21, 52, 0, 0, time.UTC)
	var all []cveItem
	for _, file := range []string{"cve-2014-0160.json", "cve-2024-3094.json"} {
		var p page
		if err := json.Unmarshal(readNVD(t, file), &p); err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		if p.TotalResults != 1 || len(p.Vulnerabilities) != 1 {
			t.Fatalf("%s: %d results", file, p.TotalResults)
		}
		all = append(all, p.Vulnerabilities...)
	}
	obs := Emit(all, nil, "", at)
	if len(obs.Cis) != len(nvdExpectations) || len(obs.Relationships) != 0 {
		t.Fatalf("vulnerability CIs %d relationships %d", len(obs.Cis), len(obs.Relationships))
	}
	for _, ci := range obs.Cis {
		t.Run(ci.Name, func(t *testing.T) {
			want, ok := nvdExpectations[ci.Name]
			if !ok {
				t.Fatalf("unexpected CVE %s", ci.Name)
			}
			a := ci.Attributes
			scalarAttributes(t, a)
			if ci.Type != typeVuln || ci.Identity["cveId"] != ci.Name || len(ci.ExternalIDs) != 1 || ci.ExternalIDs[0] != (contract.ExternalID{Source: "nvd", ID: ci.Name}) {
				t.Errorf("identity %+v %+v", ci.Identity, ci.ExternalIDs)
			}
			if a["severity"] != want.severity || a["cvssScore"] != want.score || a["cvssVersion"] != want.version || a["cvssVector"] != want.vector || a["cvssSource"] != want.cvssSource ||
				a["exploitabilityScore"] != want.exploitability || a["impactScore"] != want.impact {
				t.Errorf("cvss %v %v %v %v %v %v %v", a["severity"], a["cvssScore"], a["cvssVersion"], a["cvssVector"], a["cvssSource"], a["exploitabilityScore"], a["impactScore"])
			}
			if a["kev"] != want.kev || a["exploitKnown"] != want.exploit || a["kevDateAdded"] != want.kevAdded || a["kevDueDate"] != want.kevDue || a["kevName"] != want.kevName {
				t.Errorf("kev/exploit %v %v %v %v %v", a["kev"], a["exploitKnown"], a["kevDateAdded"], a["kevDueDate"], a["kevName"])
			}
			if a["status"] != want.status || a["published"] != want.published || a["source"] != "nvd" {
				t.Errorf("record %v %v", a["status"], a["published"])
			}
			cpes, _ := a["cpeMatches"].([]string)
			products, _ := a["affectedProducts"].([]string)
			refs, _ := a["references"].([]string)
			if len(cpes) != want.cpeMatches || !containsString(cpes, want.someCpe) || len(products) != want.products || !containsString(products, want.someProduct) || len(refs) != want.references {
				t.Errorf("cpe %d products %d %v refs %d", len(cpes), len(products), products, len(refs))
			}
			for i := 1; i < len(products); i++ {
				if products[i-1] >= products[i] {
					t.Errorf("affectedProducts not sorted and unique: %v", products)
				}
			}
			cwe, _ := a["cwe"].([]string)
			if len(cwe) != len(want.cwe) || cwe[0] != want.cwe[0] {
				t.Errorf("cwe %v", cwe)
			}
		})
	}
	critical := Emit(all, nil, "CRITICAL", at)
	if len(critical.Cis) != 1 || critical.Cis[0].Name != "CVE-2024-3094" {
		t.Fatalf("severity floor CRITICAL: %+v", critical.Cis)
	}
}

func containsString(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}
