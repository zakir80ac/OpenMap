// T-041 REQ-DISC-027 — serves two NVD 2.0-shaped pages from httptest and checks pagination,
// CVSS selection, CPE extraction and the severity floor.
package vulnfeed

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/restjson"
)

func item(id, sev string, score float64, cpe string, exploit bool) map[string]any {
	tags := []string{"Vendor Advisory"}
	if exploit {
		tags = append(tags, "Exploit")
	}
	return map[string]any{"cve": map[string]any{
		"id": id, "published": "2026-10-01T10:00:00.000", "lastModified": "2026-10-20T08:00:00.000", "vulnStatus": "Analyzed",
		"descriptions":   []map[string]string{{"lang": "en", "value": "Something bad in " + cpe}},
		"metrics":        map[string]any{"cvssMetricV31": []map[string]any{{"cvssData": map[string]any{"version": "3.1", "vectorString": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", "baseScore": score, "baseSeverity": sev}, "exploitabilityScore": 3.9, "impactScore": 5.9}}},
		"weaknesses":     []map[string]any{{"description": []map[string]string{{"value": "CWE-787"}}}},
		"configurations": []map[string]any{{"nodes": []map[string]any{{"cpeMatch": []map[string]any{{"vulnerable": true, "criteria": cpe, "versionEndExcluding": "2.4.63"}, {"vulnerable": false, "criteria": "cpe:2.3:o:linux:linux_kernel:-:*:*:*:*:*:*:*"}}}}}},
		"references":     []map[string]any{{"url": "https://vendor.example/advisory", "tags": tags}},
	}}
}

func TestFetchAndEmit(t *testing.T) {
	calls := 0
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("apiKey") != "k" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		start, _ := strconv.Atoi(r.URL.Query().Get("startIndex"))
		var vulns []map[string]any
		if start == 0 {
			vulns = []map[string]any{item("CVE-2026-0001", "CRITICAL", 9.8, "cpe:2.3:a:apache:http_server:*:*:*:*:*:*:*:*", true)}
		} else {
			vulns = []map[string]any{item("CVE-2026-0002", "LOW", 2.1, "cpe:2.3:a:gnu:less:*:*:*:*:*:*:*:*", false)}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"resultsPerPage": 1, "startIndex": start, "totalResults": 2, "vulnerabilities": vulns})
	}))
	defer srv.Close()
	c, _ := restjson.New(srv.URL, defaultPort, restjson.Auth{}, restjson.Options{Headers: map[string]string{"apiKey": "k"}})
	items, raw, err := Fetch(context.Background(), c, "/rest/json/cves/2.0", time.Hour, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 || calls != 2 || len(raw) != 2 {
		t.Fatalf("pagination wrong: items=%d calls=%d raw=%d", len(items), calls, len(raw))
	}
	obs := Emit(items, raw, "", time.Now())
	if len(obs.Cis) != 2 || obs.Cis[0].Identity["cveId"] != "CVE-2026-0001" || obs.Cis[0].Attributes["severity"] != "CRITICAL" || obs.Cis[0].Attributes["exploitKnown"] != true {
		t.Fatalf("emit wrong: %+v", obs.Cis)
	}
	products, _ := obs.Cis[0].Attributes["affectedProducts"].([]string)
	if len(products) != 1 || products[0] != "apache:http_server" {
		t.Fatalf("cpe products wrong: %+v", products)
	}
	filtered := Emit(items, nil, "HIGH", time.Now())
	if len(filtered.Cis) != 1 {
		t.Fatalf("severity floor not applied: %d", len(filtered.Cis))
	}
}
