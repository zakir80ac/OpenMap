// T-444 REQ-QA-005 REQ-DISC-027 — regressions the simulated NVD exposed: a feed mirror behind a private CA is
// pinned with caCertPem (the client ignored it and only trusted the system pool); a window longer than the
// NVD's 120-day range limit is read as consecutive ranges (one range answered 404 on the real API); pages
// advance by the records a page held, so a mirror capping resultsPerPage below the request loses nothing;
// a CVE on a range boundary is kept once.
package vulnfeed

import (
	"context"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func TestRangesPagesAndPinnedCA(t *testing.T) {
	now := time.Now().UTC()
	const total = 9
	const mirrorCap = 2
	// One CVE every 30 days back from now; the last range boundary falls on none of them exactly, so a
	// boundary duplicate is forced by serving CVE-0 in every range.
	modified := make([]time.Time, total)
	for i := range modified {
		modified[i] = now.Add(-time.Duration(i*30*24) * time.Hour)
	}
	var ranges [][2]time.Time
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		from, err1 := time.Parse(nvdTimeLayout, q.Get("lastModStartDate"))
		to, err2 := time.Parse(nvdTimeLayout, q.Get("lastModEndDate"))
		if err1 != nil || err2 != nil || to.Sub(from) > maxRange {
			w.Header().Set("message", "Invalid date range")
			w.WriteHeader(http.StatusNotFound)
			return
		}
		start, _ := strconv.Atoi(q.Get("startIndex"))
		per, _ := strconv.Atoi(q.Get("resultsPerPage"))
		if per > mirrorCap {
			per = mirrorCap
		}
		var ids []string
		for i, m := range modified {
			if i == 0 || (!m.Before(from) && !m.After(to)) {
				ids = append(ids, fmt.Sprintf("CVE-2026-%04d", i))
			}
		}
		sort.Strings(ids)
		if start == 0 {
			ranges = append(ranges, [2]time.Time{from, to})
		}
		end := start + per
		if end > len(ids) {
			end = len(ids)
		}
		vulns := []map[string]any{}
		for _, id := range ids[start:end] {
			vulns = append(vulns, item(id, "HIGH", 7.5, "cpe:2.3:a:openssl:openssl:*:*:*:*:*:*:*:*", false))
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"resultsPerPage": len(vulns), "startIndex": start, "totalResults": len(ids), "vulnerabilities": vulns})
	}))
	defer srv.Close()
	ca := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}))
	target := contract.Target{Kind: "url", Value: srv.URL + "/rest/json/cves/2.0"}
	windowHours := total * 30 * 24

	if _, err := (Collector{}).Collect(context.Background(), target, nil, map[string]any{optionWindow: windowHours}); err == nil {
		t.Fatal("a private-CA mirror must fail without caCertPem")
	}
	ranges = nil
	obs, err := Collector{}.Collect(context.Background(), target, nil, map[string]any{optionWindow: windowHours, optionCA: ca, optionPageSize: 5})
	if err != nil {
		t.Fatal(err)
	}
	if len(ranges) < 3 {
		t.Fatalf("a %d-hour window must be read as several ranges of at most 120 days, got %d", windowHours, len(ranges))
	}
	for i := 1; i < len(ranges); i++ {
		if !ranges[i][0].Equal(ranges[i-1][1]) {
			t.Fatalf("ranges must be consecutive: %v then %v", ranges[i-1], ranges[i])
		}
	}
	ids := map[string]int{}
	for _, c := range obs.Cis {
		ids[c.Identity["cveId"]]++
	}
	if len(ids) != total || len(obs.Cis) != total {
		t.Fatalf("expected %d distinct CVEs once each across capped pages and ranges, got %d CIs: %v", total, len(obs.Cis), ids)
	}
}
